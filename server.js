const admin = require("firebase-admin");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

/* ---------------- INITIALIZATION ---------------- */

let serviceAccount;
const localKeyPath = path.join(__dirname, "serviceAccountKey.json");

if (fs.existsSync(localKeyPath)) {
    // Load from local file for development
    serviceAccount = require(localKeyPath);
    console.log("Loaded credentials from local serviceAccountKey.json");
} else if (process.env.FIREBASE_CONFIG) {
    // Load from environment variable for production (GitHub Actions)
    serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
    console.log("Loaded credentials from environment variable");
} else {
    console.error("ERROR: No Firebase credentials found!");
    process.exit(1);
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const BASE = "https://indialotteryapi.com/wp-json/klr/v1";

/* ---------------- LOGIC ---------------- */

async function bootstrapHistory() {
    console.log("Bootstrapping historical data...");
    let offset = 0;
    // Set a safe limit for Spark plan (Firestore write limits)
    while (offset < 100) { 
        try {
            const res = await axios.get(`${BASE}/history?limit=20&offset=${offset}`);
            const items = res.data.items;
            
            if (!items || items.length === 0) break;

            const batch = db.batch();
            items.forEach(item => {
                const ref = db.collection("history").doc(item.draw_code);
                batch.set(ref, item);
            });
            
            await batch.commit();
            console.log(`Imported batch: ${offset + items.length} records`);
            offset += 20;
        } catch (err) {
            console.error("Bootstrap batch failed:", err.message);
            break;
        }
    }
    console.log("Bootstrap finished.");
}

async function runWorker() {
    try {
        // 1. BOOTSTRAP CHECK
        const historyCheck = await db.collection("history").limit(1).get();
        if (historyCheck.empty) {
            await bootstrapHistory();
        }

        // 2. FETCH LATEST
        console.log("Checking for new results...");
        const res = await axios.get(`${BASE}/latest`);
        const apiData = res.data;

        if (!apiData || !apiData.draw_code) {
            console.log("Invalid data received from API.");
            return;
        }

        const latestDoc = await db.collection("lottery").doc("latest").get();
        const currentStored = latestDoc.exists ? latestDoc.data() : null;

        // 3. COMPARE AND SAVE
        if (!currentStored || apiData.draw_code !== currentStored.draw_code) {
            console.log(`NEW DRAW DETECTED: ${apiData.draw_code}`);
            
            // Save to 'latest' pointer and 'history' collection
            await db.collection("lottery").doc("latest").set(apiData);
            await db.collection("history").doc(apiData.draw_code).set(apiData);
            
            // Log the update
            await db.collection("logs").add({
                event: "NEW_DRAW",
                code: apiData.draw_code,
                time: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log("Firestore updated successfully.");
        } else {
            console.log(`No new draw. Currently at: ${currentStored.draw_code}`);
        }
    } catch (e) {
        console.error("Worker failed:", e.message);
    } finally {
        console.log("Worker finished execution.");
        process.exit(0); // Exit script after completion
    }
}

// Start the process
runWorker();