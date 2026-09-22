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
const rigRef = masterRoot ? masterRoot.child("winning_number") : null;
const auditLogRef = masterRoot ? masterRoot.child("audit_logs") : null;
const usersRef = masterRoot ? masterRoot.child("users") : null;
const depositsRef = masterRoot ? masterRoot.child("deposit_requests") : null;
const gameStateRef = masterRoot ? masterRoot.child("game_state") : null;
const activeResultRef = masterRoot ? masterRoot.child("current_round_result") : null;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;
const ROUND_TIME = 120; // 120 सेकंड (2 मिनट का मास्टर टाइमर)
const MASTER_ADMIN_PHONE = "8889865182";

const numbersList = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
const redList = [32, 19, 21, 25, 34, 27, 36, 30, 23, 5, 16, 1, 14, 9, 18, 7, 12, 3];

// एक्सप्रेस स्टैटिक ताकि फ्रंटएंड (index.html) सीधा लोड हो सके
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const activeSocketSessions = new Map();
const userRateLimitMap = new Map();

// कॉइन सीलिंग और लेजर फंक्शन
async function recordCoinLedger(phone, amount, sourceType, description) {
    try {
        let ledgerRef = usersRef.child(phone + "/ledger");
        await ledgerRef.push({
            amount: amount,
            sourceType: sourceType,
            description: description,
            timestamp: Date.now()
        });
    } catch (err) {
        console.error("Ledger error:", err);
    }
}

io.on('connection', (socket) => {
    console.log('New secure client connected:', socket.id);

    socket.on('authenticate_socket', (data) => {
        let { phone } = data;
        if (phone) activeSocketSessions.set(socket.id, phone);
    });

    socket.on('place_secure_bet', async (data) => {
        try {
            let verifiedPhone = activeSocketSessions.get(socket.id);
            if (!verifiedPhone) {
                socket.emit('bet_response', { success: false, msg: 'Unauthorized session!' });
                return;
            }

            let { key, amount, roundId } = data;
            if (!key || !amount || amount <= 0) return;

            let now = Date.now();
            let lastTime = userRateLimitMap.get(socket.id) || 0;
            if (now - lastTime < 150) return;
            userRateLimitMap.set(socket.id, now);

            let currentSec = Math.floor(Date.now() / 1000);
            let activeRound = Math.floor(currentSec / ROUND_TIME);
            let timeLeft = ROUND_TIME - (currentSec % ROUND_TIME);

            if (activeRound !== roundId || timeLeft <= 10) {
                socket.emit('bet_response', { success: false, msg: 'Betting closed!' });
                return;
            }

            let userBalRef = usersRef.child(verifiedPhone + "/balance");
            let betSuccess = false;
            let finalBal = 0;

            await userBalRef.transaction((currentBal) => {
                let currentBalance = currentBal || 0;
                if (currentBalance < amount) {
                    betSuccess = false;
                    return currentBalance;
                }
                betSuccess = true;
                finalBal = currentBalance - amount;
                return finalBal;
            });

            if (!betSuccess) {
                socket.emit('bet_response', { success: false, msg: 'Insufficient balance!' });
                return;
            }

            await recordCoinLedger(verifiedPhone, -amount, 'BET_PLACED', `Bet on ${key}`);
            let roundBetRef = masterRoot.child("live_rounds/" + activeRound + "/bets/" + verifiedPhone + "/" + key);
            await roundBetRef.transaction(curr => (curr || 0) + amount);

            socket.emit('bet_response', { success: true, newBalance: finalBal });
        } catch (err) {
            console.error("Bet error:", err);
        }
    });

    socket.on('admin_secure_coin_action', async (data) => {
        try {
            let adminPhone = activeSocketSessions.get(socket.id);
            if (adminPhone !== MASTER_ADMIN_PHONE) return;

            let { targetInputKey, amount, actionType } = data;
            let allUsersSnap = await usersRef.once("value");
            let allUsers = allUsersSnap.val() || {};
            let matchedPhone = "";

            if (targetInputKey.length === 10 && !isNaN(targetInputKey)) matchedPhone = targetInputKey;
            else {
                let upperId = targetInputKey.toUpperCase();
                for (let ph in allUsers) {
                    if (allUsers[ph].vipId && allUsers[ph].vipId.toUpperCase() === upperId) {
                        matchedPhone = ph;
                        break;
                    }
                }
            }
            if (!matchedPhone && targetInputKey.length >= 10) matchedPhone = targetInputKey;
            if (!matchedPhone) return;

            let currentBal = (allUsers[matchedPhone] && allUsers[matchedPhone].balance) ? parseInt(allUsers[matchedPhone].balance) : 0;
            let newBalance = actionType === 'add' ? currentBal + amount : Math.max(0, currentBal - amount);

            await recordCoinLedger(matchedPhone, actionType === 'add' ? amount : -amount, 'ADMIN_ACTION', `Admin ${actionType}`);
            await usersRef.child(matchedPhone).update({ balance: newBalance });

            socket.emit('admin_action_response', { success: true, newBalance: newBalance, msg: `Updated to ₹${newBalance}` });
        } catch (err) {}
    });

    socket.on('disconnect', () => {
        activeSocketSessions.delete(socket.id);
        userRateLimitMap.delete(socket.id);
    });
});

function calculateSmartWinner(roundId, globalTableBets, totalTableBet) {
    if (totalTableBet === 0) return numbersList[Math.abs(roundId) % numbersList.length];
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
        if (payout <= safePayoutPool) validSafeNumbers.push(num);
    });

    if (validSafeNumbers.length === 0) {
        let minNum = numbersList[0], minPayout = Infinity;
        for (let num in allNumberPayouts) {
            if (allNumberPayouts[num] < minPayout) { minPayout = allNumberPayouts[num]; minNum = parseInt(num); }
        }
        return minNum;
    }
    return validSafeNumbers[Math.abs(roundId * 17) % validSafeNumbers.length];
}

// 👑 101% BULLETPROOF SYNCHRONIZED SETTLEMENT & SPIN-MATCHED HISTORY
async function executeRoundSettlement(roundId) {
    let lockRef = masterRoot.child("settlement_locks/" + roundId);
    let acquiredLock = false;

    await lockRef.transaction((currentLock) => {
        if (currentLock && currentLock.locked) {
            acquiredLock = false;
            return currentLock;
        }
        acquiredLock = true;
        return { locked: true, time: Date.now() };
    });

    if (!acquiredLock) {
        console.log(`⚠️ Round #${roundId} settlement already claimed. Skipping.`);
        return;
    }

    console.log(`🔒 Master Engine executing synced settlement for Round #${roundId}...`);
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

        // 👑 एटॉमिक रिग फैच और तुरंत डेटाबेस से डिलीट
        let winningNum = null;
        await rigRef.transaction((currentRig) => {
            if (currentRig !== null && currentRig !== "random" && currentRig !== "" && !isNaN(currentRig)) {
                winningNum = parseInt(currentRig);
                return "random"; 
            }
            return currentRig;
        });

        if (winningNum === null || isNaN(winningNum)) {
            winningNum = calculateSmartWinner(roundId, globalTableBets, totalTableBet);
            console.log(`🤖 Smart Safe Engine Winning Number: ${winningNum}`);
        } else {
            console.log(`👑 Admin Forced Winning Number (Executed & Cleared): ${winningNum}`);
        }

        // खिलाड़ियों को पेआउट दें
        let isRed = redList.includes(winningNum);
        for (let phone in allBetsData) {
            let userBets = allBetsData[phone];
            let totalWon = 0;
            for (let key in userBets) {
                let amt = userBets[key];
                if (key === winningNum.toString()) totalWon += amt * 36;
                else if (key === 'red' && isRed) totalWon += amt * 2;
                else if (key === 'black' && !isRed && winningNum !== 0) totalWon += amt * 2;
            }

            if (totalWon > 0) {
                await recordCoinLedger(phone, totalWon, 'ROUND_WIN', `Won ₹${totalWon} in Round #${roundId}`);
                let userBalRef = usersRef.child(phone + "/balance");
                await userBalRef.transaction(current => (current || 0) + totalWon);
            }
        }

        // 1️⃣ सबसे पहले व्हील घूमने और पॉपअप दिखाने के लिए रिजल्ट ट्रिगर करें
        await activeResultRef.set({
            roundId: roundId,
            winningNum: winningNum,
            timestamp: Date.now()
        });
        io.emit('round_ended', { winningNum, roundId });

        // 2️⃣ 🕒 ठीक 5 सेकंड बाद (जब व्हील घूमकर गेंद पूरी तरह रुक जाए और पॉपअप आ जाए), तब हिस्ट्री में नंबर जोड़ें
        setTimeout(async () => {
            if (historyRef) {
                await historyRef.transaction((curHist) => {
                    let hist = curHist || [24, 14, 5, 22, 10, 3];
                    if (hist[0] !== winningNum) {
                        hist.unshift(winningNum);
                        if (hist.length > 8) hist.pop();
                    }
                    return hist;
                });
            }
        }, 5000); // 5000ms = गेंद रुकने का एग्जैक्ट समय

    } catch (error) {
        console.error("❌ Settlement failed:", error);
    }
}

// मास्टर गेम लूप
function startMasterGameLoop() {
    setInterval(async () => {
        try {
            let nowSec = Math.floor(Date.now() / 1000);
            let roundId = Math.floor(nowSec / ROUND_TIME);
            let timeLeft = ROUND_TIME - (nowSec % ROUND_TIME);

            if (gameStateRef) {
                gameStateRef.child("timer").set({ roundId, timeLeft });
            }

            io.emit('timer_update', { roundId, timeLeft });

            if (timeLeft <= 1) {
                await executeRoundSettlement(roundId);
            }
        } catch (err) {
            console.error('❌ Loop error:', err);
        }
    }, 1000);
}

server.listen(PORT, () => {
    console.log(`👑 Royal Roulette Spin-Matched Master Engine running on port ${PORT}`);
    startMasterGameLoop();
});
