const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const admin = require('firebase-admin');

// Render के एनवायरनमेंट वेरिएबल से फायरबेस चाबी सुरक्षित रूप से लोड करना
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://royal-dijital-default-rtdb.firebaseio.com"
});

const db = admin.database();
const masterRoot = db.ref("royal_roulette_master_cloud_v23");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;
const ROUND_TIME = 120; // 120 सेकंड प्रति राउंड

const numbersList = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
const redList = [32, 19, 21, 25, 34, 27, 36, 30, 23, 5, 16, 1, 14, 9, 18, 7, 12, 3];

// एक्सप्रेस बेसिक रूट
app.use(express.json());
app.get('/', (req, res) => {
    res.send('ROYAL ROULETTE MASTER CLOUD BACKEND IS RUNNING 🚀');
});

// सॉकेट कनेक्शन हैंडलिंग
io.on('connection', (socket) => {
    console.log('🔗 New client connected to master server:', socket.id);

    socket.on('disconnect', () => {
        console.log('❌ Client disconnected:', socket.id);
    });
});

// 🌟 मास्टर बैकएंड गेम लूप (ऑथोरिटेटिव टाइमर और सेटलमेंट इंजन)
function startMasterGameLoop() {
    setInterval(async () => {
        try {
            let nowSec = Math.floor(Date.now() / 1000);
            let roundId = Math.floor(nowSec / ROUND_TIME);
            let timeLeft = ROUND_TIME - (nowSec % ROUND_TIME);

            // हर सेकंड टाइमर की स्थिति ब्रॉडकास्ट करें
            io.emit('timer_update', { roundId, timeLeft });

            // यदि राउंड खत्म होने वाला है (यानी अंतिम सेकंड में), तो सेटलमेंट प्रक्रिया चलाएं
            if (timeLeft === 1) {
                await executeRoundSettlement(roundId);
            }
        } catch (err) {
            console.error("❌ Error in master game loop:", err);
        }
    }, 1000);
}

// 🌟 राउंड सेटलमेंट और विनर कैलकुलेशन फंक्शन
async function executeRoundSettlement(roundId) {
    console.log(`🎰 Executing settlement for Round #${roundId}...`);

    try {
        // 1. डेटाबेस से इस राउंड की सभी बेट्स लाएं
        let betsSnap = await masterRoot.child(`live_rounds/${roundId}/bets`).once('value');
        let allBetsData = betsSnap.val() || {};

        let globalTableBets = {};
        let totalTableBet = 0;

        Object.keys(allBetsData).forEach(phone => {
            let userBets = allBetsData[phone] || {};
            Object.keys(userBets).forEach(numKey => {
                let amt = parseInt(userBets[numKey]) || 0;
                globalTableBets[numKey] = (globalTableBets[numKey] || 0) + amt;
                totalTableBet += amt;
            });
        });

        // 2. 95% पूल और 5% हाउस मार्जिन के हिसाब से सुरक्षित विनर नंबर चुनें
        let winningNum = calculateSmartWinner(roundId, globalTableBets, totalTableBet);
        console.log(`🎉 Winning Number for Round #${roundId} is: ${winningNum}`);

        // 3. इतिहास (History) अपडेट करें
        let historyRef = masterRoot.child("history_list");
        let histSnap = await historyRef.once('value');
        let currentHist = histSnap.val() || [];
        currentHist.unshift(winningNum);
        if (currentHist.length > 6) currentHist.pop();
        await historyRef.set(currentHist);

        // 4. सभी खिलाड़ियों के विनिंग अमाउंट का हिसाब लगाकर उनके वॉलेट में पैसे क्रेडिट करें
        let isRed = redList.includes(winningNum);
        for (let phone in allBetsData) {
            let userBets = allBetsData[phone];
            let totalWon = 0;

            for (let key in userBets) {
                let amt = userBets[key];
                if (key === winningNum.toString()) {
                    totalWon += amt * 36;
                } else if (key === 'red' && isRed) {
                    totalWon += amt * 2;
                } else if (key === 'black' && !isRed && winningNum !== 0) {
                    totalWon += amt * 2;
                }
            }

            if (totalWon > 0) {
                let userBalRef = masterRoot.child(`users/${phone}/balance`);
                await userBalRef.transaction(currentBal => {
                    return (currentBal || 0) + totalWon;
                });
                console.log(`💰 Credited ₹${totalWon} to user: ${phone}`);
            }
        }

        // सभी क्लाइंट्स को रिजल्ट की सूचना दें
        io.emit('round_ended', { roundId, winningNum });

    } catch (error) {
        console.error("❌ Settlement failed:", error);
    }
}

// स्मार्ट विनर कैलकुलेटर (5% हाउस सेफ गार्ड)
function calculateSmartWinner(roundId, globalTableBets, totalTableBet) {
    if (totalTableBet === 0) {
        return numbersList[Math.abs(roundId) % numbersList.length];
    }

    let safePayoutPool = totalTableBet * 0.95;
    let validSafeNumbers = [];
    let allNumberPayouts = {};

    numbersList.forEach(num => {
        let payout = 0;
        let isRed = redList.includes(num);
        for (let key in globalTableBets) {
            let amt = globalTableBets[key];
            if (key === num.toString()) payout += amt * 36;
            else if (key === 'red' && isRed) payout += amt * 2;
            else if (key === 'black' && !isRed && num !== 0) payout += amt * 2;
        }
        allNumberPayouts[num] = payout;
        if (payout <= safePayoutPool) {
            validSafeNumbers.push(num);
        }
    });

    if (validSafeNumbers.length === 0) {
        let minNum = numbersList[0];
        let minPayout = Infinity;
        for (let num in allNumberPayouts) {
            if (allNumberPayouts[num] < minPayout) {
                minPayout = allNumberPayouts[num];
                minNum = parseInt(num);
            }
        }
        return minNum;
    }

    let selectedIndex = Math.abs(roundId * 17) % validSafeNumbers.length;
    return validSafeNumbers[selectedIndex];
}

server.listen(PORT, () => {
    console.log(`🚀 Royal Roulette Master Server running on port ${PORT}`);
    startMasterGameLoop();
});
