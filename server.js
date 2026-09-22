const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const admin = require('firebase-admin');

// Render के एनवायरनमेंट वेरिएबल से Firebase सुरक्षित रूप से लोड करना
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://royal-dijital-default-rtdb.firebaseio.com"
    });
} catch(e) {
    console.log("Firebase init error:", e.message);
}

const db = admin.apps.length ? admin.database() : null;
const masterRoot = db ? db.ref("royal_roulette_master_cloud_v23") : null;
const historyRef = masterRoot ? masterRoot.child("history_list") : null;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;
const ROUND_TIME = 120; // 120 सेकंड (2 मिनट)
const numbersList = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
const redList = [32, 19, 21, 25, 34, 27, 36, 30, 23, 5, 16, 1, 14, 9, 18, 7, 12, 3];

// एक्सप्रेस स्टैटिक ताकि फ्रंटएंड (index.html) सीधा लोड हो सके
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// सॉकेट कनेक्शन हैंडलिंग
io.on('connection', (socket) => {
    console.log('New client connected to master server:', socket.id);
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

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

// राउंड सेटलमेंट और पेआउट फंक्शन
async function executeRoundSettlement(roundId) {
    console.log(`⚡ Executing settlement for Round #${roundId}...`);
    try {
        let betsSnap = await masterRoot.child("live_rounds/" + roundId + "/bets").once("value");
        let allBetsData = betsSnap.val() || {};

        let globalTableBets = {};
        let totalTableBet = 0;

        Object.keys(allBetsData).forEach(phone => {
            let userBets = allBetsData[phone] || {};
            Object.keys(userBets).forEach(key => {
                let amt = parseInt(userBets[key]) || 0;
                globalTableBets[key] = (globalTableBets[key] || 0) + amt;
                totalTableBet += amt;
            });
        });

        let winningNum = calculateSmartWinner(roundId, globalTableBets, totalTableBet);
        console.log(`🏆 Winning Number for Round #${roundId} is: ${winningNum}`);

        // इतिहास (History) अपडेट करें
        if (historyRef) {
            let histSnap = await historyRef.once("value");
            let curHist = histSnap.val() || [24, 14, 5, 22, 10, 3];
            curHist.unshift(winningNum);
            if (curHist.length > 8) curHist.pop();
            await historyRef.set(curHist);
        }

        // खिलाड़ियों के बैलेंस का हिसाब लगाएं
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
                let userBalRef = masterRoot.child("users/" + phone + "/balance");
                await userBalRef.transaction(current => (current || 0) + totalWon);
                console.log(`💰 Credited ₹${totalWon} to user: ${phone}`);
            }
        }

        io.emit('round_ended', { winningNum, roundId });
    } catch (error) {
        console.error("❌ Settlement failed:", error);
    }
}

// मास्टर गेम लूप (टाइमर)
function startMasterGameLoop() {
    setInterval(async () => {
        try {
            let nowSec = Math.floor(Date.now() / 1000);
            let roundId = Math.floor(nowSec / ROUND_TIME);
            let timeLeft = ROUND_TIME - (nowSec % ROUND_TIME);

            io.emit('timer_update', { roundId, timeLeft });

            if (timeLeft === 1) {
                await executeRoundSettlement(roundId);
            }
        } catch (err) {
            console.error('❌ Error in master game loop:', err);
        }
    }, 1000);
}

server.listen(PORT, () => {
    console.log(`👑 Royal Roulette Master Server running on port ${PORT}`);
    startMasterGameLoop();
});
