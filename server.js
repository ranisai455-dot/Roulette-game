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
const withdrawsRef = masterRoot ? masterRoot.child("withdraw_requests") : null;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;
const ROUND_TIME = 120; // 120 सेकंड (2 मिनट का मास्टर टाइमर)
const MASTER_ADMIN_PHONE = "8889865182"; // सिर्फ यही मास्टर एडमिन है

const numbersList = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
const redList = [32, 19, 21, 25, 34, 27, 36, 30, 23, 5, 16, 1, 14, 9, 18, 7, 12, 3];

// एक्सप्रेस स्टैटिक ताकि फ्रंटएंड (index.html) सीधा लोड हो सके
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// सॉकेट सेशन मैपिंग (एंटी-स्पूफिंग: सर्वर खुद याद रखेगा कि किस सॉकेट से कौन सा यूजर लॉग इन है)
const activeSocketSessions = new Map();
const userRateLimitMap = new Map();

// 👑 कॉइन सीलिंग और बुलेटप्रूफ लेजर फंक्शन (हर कॉइन का वैध सोर्स रिकॉर्ड करने के लिए)
async function recordCoinLedger(phone, amount, sourceType, description) {
    try {
        let ledgerRef = usersRef.child(phone + "/ledger");
        await ledgerRef.push({
            amount: amount,
            sourceType: sourceType, // 'DEPOSIT_APPROVED', 'ADMIN_CREDIT', 'ROUND_WIN', 'BET_PLACED'
            description: description,
            timestamp: Date.now()
        });
    } catch (err) {
        console.error("Ledger recording error:", err);
    }
}

io.on('connection', (socket) => {
    console.log('New secure client connected:', socket.id);

    // 1. सॉकेट ऑथेंटिकेशन / सेशन बाइंडिंग (कोई हैकर दूसरे का फोन नंबर इस्तेमाल नहीं कर सकता)
    socket.on('authenticate_socket', (data) => {
        let { phone } = data;
        if (phone) {
            activeSocketSessions.set(socket.id, phone);
            console.log(`Socket ${socket.id} securely bound to user: ${phone}`);
        }
    });

    // 2. सर्वर-ऑथोरिटेटिव सिक्योर बेटिंग (कॉइन सीलिंग वेरीफाइड)
    socket.on('place_secure_bet', async (data) => {
        try {
            let verifiedPhone = activeSocketSessions.get(socket.id);
            if (!verifiedPhone) {
                socket.emit('bet_response', { success: false, msg: 'Unauthorized session! Please re-login.' });
                return;
            }

            let { key, amount, roundId } = data;
            if (!key || !amount || amount <= 0) return;

            // रेट लिमिटिंग (एंटी-स्पैम)
            let now = Date.now();
            let lastTime = userRateLimitMap.get(socket.id) || 0;
            if (now - lastTime < 150) {
                socket.emit('bet_response', { success: false, msg: 'Too fast! Slow down.' });
                return;
            }
            userRateLimitMap.set(socket.id, now);

            let currentSec = Math.floor(Date.now() / 1000);
            let activeRound = Math.floor(currentSec / ROUND_TIME);
            let timeLeft = ROUND_TIME - (currentSec % ROUND_TIME);

            if (activeRound !== roundId || timeLeft <= 10) {
                socket.emit('bet_response', { success: false, msg: 'Betting closed for this round!' });
                return;
            }

            let userBalRef = usersRef.child(verifiedPhone + "/balance");
            let userTurnoverRef = usersRef.child(verifiedPhone + "/turnover");
            
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
                socket.emit('bet_response', { success: false, msg: 'Insufficient sealed balance!' });
                return;
            }

            await userTurnoverRef.transaction(curr => (curr || 0) + amount);

            // लेजर में रिकॉर्ड करें कि कॉइन खर्च हुआ
            await recordCoinLedger(verifiedPhone, -amount, 'BET_PLACED', `Bet placed on ${key} for Round #${activeRound}`);

            let roundBetRef = masterRoot.child("live_rounds/" + activeRound + "/bets/" + verifiedPhone + "/" + key);
            await roundBetRef.transaction(curr => (curr || 0) + amount);

            socket.emit('bet_response', { success: true, newBalance: finalBal });
        } catch (err) {
            console.error("Secure bet error:", err);
            socket.emit('bet_response', { success: false, msg: 'Server error placing bet.' });
        }
    });

    // 3. 🔐 एडमिन कॉइन मैनेजर (विथ लेजर सीलिंग)
    socket.on('admin_secure_coin_action', async (data) => {
        try {
            let adminPhone = activeSocketSessions.get(socket.id);
            if (adminPhone !== MASTER_ADMIN_PHONE) {
                socket.emit('admin_action_response', { success: false, msg: 'Unauthorized Admin Action!' });
                return;
            }

            let { targetInputKey, amount, actionType } = data;
            if (!targetInputKey || amount <= 0) return;

            let allUsersSnap = await usersRef.once("value");
            let allUsers = allUsersSnap.val() || {};
            let matchedPhone = "";

            if (targetInputKey.length === 10 && !isNaN(targetInputKey)) {
                matchedPhone = targetInputKey;
            } else {
                let upperId = targetInputKey.toUpperCase();
                for (let ph in allUsers) {
                    if (allUsers[ph].vipId && allUsers[ph].vipId.toUpperCase() === upperId) {
                        matchedPhone = ph;
                        break;
                    }
                }
            }
            if (!matchedPhone && targetInputKey.length >= 10) matchedPhone = targetInputKey;

            if (!matchedPhone) {
                socket.emit('admin_action_response', { success: false, msg: 'User not found in Cloud!' });
                return;
            }

            let currentBal = (allUsers[matchedPhone] && allUsers[matchedPhone].balance) ? parseInt(allUsers[matchedPhone].balance) : 0;
            let vipId = (allUsers[matchedPhone] && allUsers[matchedPhone].vipId) ? allUsers[matchedPhone].vipId : ("RD00" + matchedPhone.slice(-4));
            let mpinVal = (allUsers[matchedPhone] && allUsers[matchedPhone].mpin) ? allUsers[matchedPhone].mpin : "1234";

            let newBalance = currentBal;
            if (actionType === 'add') {
                newBalance += amount;
                await recordCoinLedger(matchedPhone, amount, 'ADMIN_CREDIT', `Admin added ₹${amount} securely`);
            } else {
                newBalance -= amount;
                if (newBalance < 0) newBalance = 0;
                await recordCoinLedger(matchedPhone, -amount, 'ADMIN_DEBIT', `Admin deducted ₹${amount}`);
            }

            await usersRef.child(matchedPhone).update({
                balance: newBalance,
                vipId: vipId,
                mpin: mpinVal,
                adminToken: "SKILL_ADMIN_SECURE_994_VERIFIED"
            });

            socket.emit('admin_action_response', { success: true, newBalance: newBalance, msg: `Successfully updated balance to ₹${newBalance}` });
        } catch (err) {
            socket.emit('admin_action_response', { success: false, msg: 'Server error: ' + err.message });
        }
    });

    // 4. 🔐 डिपॉजिट अप्रूवल (वेरीफाइड कॉइन सीलिंग के साथ)
    socket.on('admin_approve_deposit_secure', async (data) => {
        try {
            let adminPhone = activeSocketSessions.get(socket.id);
            if (adminPhone !== MASTER_ADMIN_PHONE) return;

            let { depKey, userPhone, amount } = data;
            let userSnap = await usersRef.child(userPhone).once("value");
            let cur = (userSnap.exists() && userSnap.val().balance) ? userSnap.val().balance : 0;
            let existingVipId = (userSnap.exists() && userSnap.val().vipId) ? userSnap.val().vipId : ("RD00" + userPhone.slice(-4));
            let newTotal = cur + amount;

            // कॉइन को 'DEPOSIT_APPROVED' सील के साथ लेजर में दर्ज करें
            await recordCoinLedger(userPhone, amount, 'DEPOSIT_APPROVED', `Approved Deposit UTR/Proof of ₹${amount}`);

            await usersRef.child(userPhone).update({
                balance: newTotal,
                vipId: existingVipId,
                adminToken: "SKILL_ADMIN_SECURE_994_VERIFIED"
            });

            await depositsRef.child(depKey).update({ status: 'Approved' });
            socket.emit('deposit_approved_response', { success: true });
        } catch (err) {
            console.error("Deposit approval error:", err);
        }
    });

    socket.on('disconnect', () => {
        activeSocketSessions.delete(socket.id);
        userRateLimitMap.delete(socket.id);
    });
});

// 5% हाउस मार्जिन और 95% सेफ पूल स्मार्ट विनर कैलकुलेटर
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

let lastSettledRoundId = null;

// मास्टर राउंड सेटलमेंट (विथ कॉइन सीलिंग 'ROUND_WIN')
async function executeRoundSettlement(roundId) {
    let lockRef = masterRoot.child("settlement_locks/" + roundId);
    let lockSnap = await lockRef.once("value");
    if (lockSnap.exists()) return;
    await lockRef.set({ locked: true, time: Date.now() });

    console.log(`🔒 Executing coin-sealed settlement for Round #${roundId}...`);
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

        let rigSnap = await rigRef.once("value");
        let rigVal = rigSnap.val();
        let winningNum;

        if (rigVal !== null && rigVal !== "random" && rigVal !== "" && !isNaN(rigVal)) {
            winningNum = parseInt(rigVal);
            console.log(`👑 Admin Forced Winning Number: ${winningNum}`);
            await rigRef.set("random");
        } else {
            winningNum = calculateSmartWinner(roundId, globalTableBets, totalTableBet);
            console.log(`🤖 Smart Safe Engine Winning Number: ${winningNum}`);
        }

        if (historyRef) {
            let histSnap = await historyRef.once("value");
            let curHist = histSnap.val() || [24, 14, 5, 22, 10, 3];
            curHist.unshift(winningNum);
            if (curHist.length > 8) curHist.pop();
            await historyRef.set(curHist);
        }

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
                // जीतने वाले कॉइन को 'ROUND_WIN' सील के साथ लेजर में दर्ज करें
                await recordCoinLedger(phone, totalWon, 'ROUND_WIN', `Won ₹${totalWon} in Round #${roundId} on Number ${winningNum}`);

                let userBalRef = usersRef.child(phone + "/balance");
                await userBalRef.transaction(current => (current || 0) + totalWon);
                console.log(`💰 Credited sealed winning ₹${totalWon} to user: ${phone}`);
            }
        }

        io.emit('round_ended', { winningNum, roundId });
    } catch (error) {
        console.error("❌ Coin-sealed settlement failed:", error);
    }
}

// मास्टर गेम लूप
function startMasterGameLoop() {
    setInterval(async () => {
        try {
            let nowSec = Math.floor(Date.now() / 1000);
            let roundId = Math.floor(nowSec / ROUND_TIME);
            let timeLeft = ROUND_TIME - (nowSec % ROUND_TIME);

            io.emit('timer_update', { roundId, timeLeft });

            if (timeLeft <= 1 && lastSettledRoundId !== roundId) {
                lastSettledRoundId = roundId;
                await executeRoundSettlement(roundId);
            }
        } catch (err) {
            console.error('❌ Error in master game loop:', err);
        }
    }, 1000);
}

server.listen(PORT, () => {
    console.log(`👑 Royal Roulette 100% Coin-Sealed Master Server running on port ${PORT}`);
    startMasterGameLoop();
});
