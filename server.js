const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
const path = require('path');

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
const usersRef = masterRoot ? masterRoot.child("users") : null;
const gameStateRef = masterRoot ? masterRoot.child("game_state") : null;
const activeResultRef = masterRoot ? masterRoot.child("current_round_result") : null;
const securityAlertsRef = masterRoot ? masterRoot.child("security_alerts") : null;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
    transports: ['polling', 'websocket']
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname), {
    etag: false,
    maxAge: 0,
    setHeaders: (res, path) => {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
}));

const PORT = process.env.PORT || 3000;
const ROUND_TIME = 120; // 120 सेकंड (2 मिनट)

const numbersList = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
const redList = [32, 19, 21, 25, 34, 27, 36, 30, 23, 5, 16, 1, 14, 9, 18, 7, 12, 3];

const activeSocketSessions = new Map();
const userRateLimitMap = new Map();

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

async function logSecurityThreat(phone, threatType, details) {
    try {
        if (securityAlertsRef) {
            await securityAlertsRef.push({
                phone: phone || "Unknown",
                threatType: threatType,
                details: details,
                timestamp: Date.now()
            });
        }
    } catch(e) {}
}

io.on('connection', (socket) => {
    socket.on('authenticate_socket', (data) => {
        let { phone } = data;
        if (phone) activeSocketSessions.set(socket.id, phone);
    });

    socket.on('place_secure_bet', async (data) => {
        try {
            let verifiedPhone = activeSocketSessions.get(socket.id);
            if (!verifiedPhone) {
                socket.emit('bet_response', { success: false, msg: 'Session expired! Re-login.' });
                return;
            }

            let { key, amount, roundId } = data;
            if (!key || typeof amount !== 'number' || amount <= 0 || amount > 500000) {
                await logSecurityThreat(verifiedPhone, "MALFORMED_BET", `Invalid amount: ${amount}`);
                socket.emit('bet_response', { success: false, msg: 'Security Alert: Invalid bet!' });
                return;
            }

            let now = Date.now();
            let lastTime = userRateLimitMap.get(socket.id) || 0;
            if (now - lastTime < 10) return;
            userRateLimitMap.set(socket.id, now);

            let currentSec = Math.floor(Date.now() / 1000);
            let serverRound = Math.floor(currentSec / ROUND_TIME);
            // 👑 क्लॉक ड्रिफ्ट और मिसमैच रोकने के लिए क्लाइंट और सर्वर राउंड का सटीक तालमेल
            let targetRound = (roundId && Math.abs(roundId - serverRound) <= 1) ? roundId : serverRound;
            let timeLeft = ROUND_TIME - (currentSec % ROUND_TIME);

            if (timeLeft <= 3) {
                socket.emit('bet_response', { success: false, msg: 'Betting closed for this round!' });
                return;
            }

            let userBalRef = usersRef.child(verifiedPhone + "/balance");
            let betSuccess = false;
            let finalBal = 0;

            await userBalRef.transaction((currentBal) => {
                let currentBalance = currentBal !== undefined ? currentBal : 0;
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

            await recordCoinLedger(verifiedPhone, -amount, 'BET_PLACED', `Bet on [${key}] for ₹${amount}`);
            let roundBetRef = masterRoot.child("live_rounds/" + targetRound + "/bets/" + verifiedPhone + "/" + key);
            await roundBetRef.transaction(curr => (curr || 0) + amount);

            socket.emit('bet_response', { success: true, newBalance: finalBal, key: key, amount: amount });
        } catch (err) {
            console.error("Bet error:", err);
            socket.emit('bet_response', { success: false, msg: 'Server error placing bet.' });
        }
    });

    socket.on('place_secure_group_bet', async (data) => {
        try {
            let verifiedPhone = activeSocketSessions.get(socket.id);
            if (!verifiedPhone) {
                socket.emit('group_bet_response', { success: false, msg: 'Session expired! Re-login.' });
                return;
            }

            let { numbers, amountPerNum, roundId } = data;
            if (!numbers || !numbers.length || !amountPerNum || amountPerNum <= 0) {
                socket.emit('group_bet_response', { success: false, msg: 'Invalid group bet!' });
                return;
            }

            let totalAmount = amountPerNum * numbers.length;
            let currentSec = Math.floor(Date.now() / 1000);
            let serverRound = Math.floor(currentSec / ROUND_TIME);
            let targetRound = (roundId && Math.abs(roundId - serverRound) <= 1) ? roundId : serverRound;
            let timeLeft = ROUND_TIME - (currentSec % ROUND_TIME);

            if (timeLeft <= 3) {
                socket.emit('group_bet_response', { success: false, msg: 'Betting closed for this round!' });
                return;
            }

            let userBalRef = usersRef.child(verifiedPhone + "/balance");
            let betSuccess = false;
            let finalBal = 0;

            await userBalRef.transaction((currentBal) => {
                let currentBalance = currentBal !== undefined ? currentBal : 0;
                if (currentBalance < totalAmount) {
                    betSuccess = false;
                    return currentBalance;
                }
                betSuccess = true;
                finalBal = currentBalance - totalAmount;
                return finalBal;
            });

            if (!betSuccess) {
                socket.emit('group_bet_response', { success: false, msg: 'Insufficient balance for group bet!' });
                return;
            }

            await recordCoinLedger(verifiedPhone, -totalAmount, 'BET_PLACED', `Group Bet total ₹${totalAmount}`);
            
            for (let num of numbers) {
                let roundBetRef = masterRoot.child("live_rounds/" + targetRound + "/bets/" + verifiedPhone + "/" + num);
                await roundBetRef.transaction(curr => (curr || 0) + amountPerNum);
            }

            socket.emit('group_bet_response', { success: true, newBalance: finalBal });
        } catch (err) {
            console.error("Group bet error:", err);
            socket.emit('group_bet_response', { success: false, msg: 'Server error placing group bet.' });
        }
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
            if (allNumberPayouts[num] < minPayout) {
                minPayout = allNumberPayouts[num];
                minNum = parseInt(num);
            }
        }
        return minNum;
    }
    return validSafeNumbers[Math.abs(roundId * 17) % validSafeNumbers.length];
}

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

    if (!acquiredLock) return;

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
        }

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
                await recordCoinLedger(phone, totalWon, 'ROUND_WIN', `Won ₹${totalWon} in Round #${roundId} on [${winningNum}]`);
                let userBalRef = usersRef.child(phone + "/balance");
                await userBalRef.transaction(current => (current || 0) + totalWon);
            }
        }

        await activeResultRef.set({
            roundId: roundId,
            winningNum: winningNum,
            timestamp: Date.now()
        });

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
        }, 5000);

    } catch (error) {
        console.error("❌ Settlement failed:", error);
    }
}

let lastSettledRound = null;
function startMasterGameLoop() {
    setInterval(async () => {
        try {
            let nowSec = Math.floor(Date.now() / 1000);
            let roundId = Math.floor(nowSec / ROUND_TIME);
            let timeLeft = ROUND_TIME - (nowSec % ROUND_TIME);

            if (gameStateRef) {
                gameStateRef.child("timer").set({ roundId, timeLeft });
            }

            if (timeLeft <= 2 && lastSettledRound !== roundId) {
                lastSettledRound = roundId;
                await executeRoundSettlement(roundId);
            }
        } catch (err) {
            console.error('❌ Loop error:', err);
        }
    }, 1000);
}

startMasterGameLoop();

setInterval(() => {
    const targetUrl = process.env.RENDER_EXTERNAL_URL || 'https://roulette-game-6cz1.onrender.com';
    https.get(targetUrl, (res) => {}).on('error', (err) => {});
}, 3 * 60 * 1000);

server.listen(PORT, () => {
    console.log(`👑 Royal Roulette Secure Server running on port ${PORT}`);
});
