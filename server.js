const express = require('express');
const admin = require('firebase-admin');
const path = require('path');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '')));

// Firebase Safe Initialization
let db = null;
let masterRoot = null;

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: 'https://royal-digital-default-rdb.firebaseio.com'
    });
    db = admin.database();
    masterRoot = db.ref("royal_roulette_master_cloud_v23");
    console.log("🔥 Firebase Initialized Successfully (Socket-free Mode)");
  } else {
    console.error("❌ FIREBASE_SERVICE_ACCOUNT environment variable is missing!");
  }
} catch (e) {
  console.error('🔥 Firebase init error:', e.message);
}

const history_list = masterRoot ? masterRoot.child('history_list') : null;
const rigRef = masterRoot ? masterRoot.child('winning_number') : null;
const gameStateRef = masterRoot ? masterRoot.child('game_state') : null;

const PORT = process.env.PORT || 3000;
const ROUND_TIME = 120; // 120 सेकंड का गेम राउंड
const numbersList = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];

// कॉइन लेजर रिकॉर्ड करने का फंक्शन
async function recordCoinLedger(phone, amount, source_type, description) {
  try {
    if (!masterRoot || !phone) return;
    let ledgerRef = masterRoot.child(`users/${phone}/ledger`);
    await ledgerRef.push({
      amount: amount,
      source_type: source_type,
      description: description,
      timestamp: Date.now()
    });
  } catch (err) {
    console.error("Ledger error:", err);
  }
}

// सुरक्षित बेट लगाने के लिए HTTP API (बिना सॉकेट के)
app.post('/api/place_secure_bet', async (req, res) => {
  try {
    if (!masterRoot) {
      return res.json({ success: false, msg: 'डेटाबेस कनेक्टेड नहीं है' });
    }

    const { phone, amount, key } = req.body;
    if (!phone || typeof amount !== 'number' || amount <= 0 || amount > 500000) {
      return res.json({ success: false, msg: 'MALFORMED_BET: अमान्य डेटा' });
    }

    let nowSec = Math.floor(Date.now() / 1000);
    let roundId = Math.floor(nowSec / ROUND_TIME);
    let timeleft = ROUND_TIME - (nowSec % ROUND_TIME);

    if (timeleft <= 3) {
      return res.json({ success: false, msg: 'बेटिंग इस राउंड के लिए बंद हो चुकी है!' });
    }

    // यूजर बैलेंस चेक और डिडक्शन
    const userBalRef = masterRoot.child(`users/${phone}/balance`);
    let currentBal = 0;
    let isSuccess = false;

    await userBalRef.transaction(current => {
      currentBal = current || 0;
      if (currentBal < amount) {
        isSuccess = false;
        return; // बैलेंस कम होने पर रोकें
      }
      isSuccess = true;
      return currentBal - amount;
    });

    if (!isSuccess) {
      return res.json({ success: false, msg: 'अपर्याप्त बैलेंस (Insufficient balance)' });
    }

    // लाइव राउंड में बेट सेव करें
    const userBetRef = masterRoot.child(`live_rounds/${roundId}/bets/${phone}`);
    await userBetRef.child(key).transaction(current => (current || 0) + Number(amount));

    // लेजर में एंट्री दर्ज करें
    await recordCoinLedger(phone, -amount, 'BET_PLACED', `Bet on ${key} for ₹${amount}`);

    return res.json({ success: true, msg: 'बेट सफलतापूर्वक लग गई!' });
  } catch (err) {
    console.error('Bet API error:', err);
    return res.json({ success: false, msg: 'सर्वर एरर, बेट नहीं लगी।' });
  }
});

// मास्टर गेम लूप टाइमर जो हमेशा Firebase को लाइव अपडेट रखेगा
setInterval(async () => {
  try {
    if (!masterRoot || !gameStateRef) return;
    let nowSec = Math.floor(Date.now() / 1000);
    let roundId = Math.floor(nowSec / ROUND_TIME);
    let timeleft = ROUND_TIME - (nowSec % ROUND_TIME);

    await gameStateRef.set({ roundId, timeleft });
  } catch (e) {
    console.error('Game loop error:', e);
  }
}, 1000);

app.listen(PORT, () => {
  console.log(`🚀 Royal Roulette Pure Firebase Server running on port ${PORT}`);
});
