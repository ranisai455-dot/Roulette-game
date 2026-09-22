const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
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
const gameStateRef = masterRoot ? masterRoot.child("game_state") : null;
const activeResultRef = masterRoot ? masterRoot.child("current_round_result") : null;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
    transports: ['polling', 'websocket']
});

const PORT = process.env.PORT || 3000;
const ROUND_TIME = 120; // 120 सेकंड (2 मिनट)
const MASTER_ADMIN_PHONE = "8889865182";

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

// 🟢 सॉकेट-बेस्ड मास्टर बेटिंग इंजन (जो पहले पूरी तरह काम कर रहा था)
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    socket.on('authenticate_socket', (data) => {
        let { phone } = data;
        if (phone) {
            activeSocketSessions.set(socket.id, phone);
        }
    });

    // 1 से 36 नंबर, रेड, ब्लैक, ज़ीरो सभी के लिए सिक्योर बेटिंग
    socket.on('place_secure_bet', async (data) => {
        try {
            let verifiedPhone = activeSocketSessions.get(socket.id);
            if (!verifiedPhone) {
                socket.emit('bet_response', { success: false, msg: 'Session expired! Re-login.' });
                return;
            }

            let { key, amount, roundId } = data;
            if (!key || !amount || amount <= 0) return;

            let now = Date.now();
            let lastTime = userRateLimitMap.get(socket.id) || 0;
            if (now - lastTime < 50) return;
            userRateLimitMap.set(socket.id, now);

            let currentSec = Math.floor(Date.now() / 1000);
            let activeRound = Math.floor(currentSec / ROUND_TIME);
            let timeLeft = ROUND_TIME - (currentSec % ROUND_TIME);
            let targetRound = (roundId && roundId > 0) ? roundId : activeRound;

            if (timeLeft <= 5) {
                socket.emit('bet_response', { success: false, msg: 'Betting closed for this round!' });
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

            await recordCoinLedger(verifiedPhone, -amount, 'BET_PLACED', `Bet on [${key}] for ₹${amount}`);
            let roundBetRef = masterRoot.child("live_rounds/" + targetRound + "/bets/" + verifiedPhone + "/" + key);
            await roundBetRef.transaction(curr => (curr || 0) + amount);

            socket.emit('bet_response', { success: true, newBalance: finalBal, key: key, amount: amount });
        } catch (err) {
            console.error("Bet error:", err);
            socket.emit('bet_response', { success: false, msg: 'Server error placing bet.' });
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
        if (payout <= safePayoutPool) {
            validSafeNumbers.push(num);
        }
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

        // 1️⃣ पहले व्हील घुमाने के लिए रिजल्ट ट्रिगर करें
        await activeResultRef.set({
            roundId: roundId,
            winningNum: winningNum,
            timestamp: Date.now()
        });
        io.emit('round_ended', { winningNum, roundId });

        // 2️⃣ ठीक 5 सेकंड बाद (जब पहिया रुके) तब हिस्ट्री में नंबर जोड़ें
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

startMasterGameLoop();

// 🟢 पूर्ण रूप से रिस्पॉन्सिव फ्रंटएंड (Socket.io + 1-36 नंबर + अंडू + मोबाइल फिट)
const HTML_CONTENT = `<!DOCTYPE html>
<html lang="en">
<head>
    <style>
        a[href*="netlify.com"] { display: none !important; opacity: 0 !important; pointer-events: none !important; visibility: hidden !important; }
        html, body { 
            overflow: hidden !important; 
            width: 100vw !important; 
            height: 100vh !important; 
            position: fixed !important; 
            margin: 0 !important; 
            padding: 0 !important; 
            background: #000201 !important; 
            -webkit-text-size-adjust: 100%; 
            touch-action: manipulation;
        }
    </style>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, shrink-to-fit=no">
    <title>ROYAL ROULETTE - 100% MASTER LIVE</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; outline: none; -webkit-tap-highlight-color: transparent; }
        body { 
            background: radial-gradient(circle at center, #011406 0%, #000201 100%); color: #f1c40f; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            text-align: center; display: flex; flex-direction: column; justify-content: space-between; 
            align-items: center; z-index: 1; transform: translateZ(0); 
        }
        #fullscreenWheelBg { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 2; overflow: hidden; background: radial-gradient(circle, #01220a 0%, #000201 85%); display: flex; align-items: center; justify-content: center; pointer-events: none; }
        .bg-wheel-wrap { position: relative; width: 300px; height: 300px; border-radius: 50%; border: 8px solid #ffd700; box-shadow: 0 0 80px rgba(255, 215, 0, 0.8); animation: wheelRotateBg 35s linear infinite; display: flex; align-items: center; justify-content: center; }
        #loginWheelCanvasBg { width: 300px; height: 300px; border-radius: 50%; display: block; filter: brightness(1.3); }
        @keyframes wheelRotateBg { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        #loginScreenContainer { 
            width: 100vw; height: 100vh; display: flex; flex-direction: column; justify-content: space-around; align-items: center; z-index: 10; 
            padding: 8px; position: absolute; top: 0; left: 0; background: radial-gradient(circle, rgba(1,27,10,0.92) 0%, rgba(0,2,1,0.99) 100%); 
        }
        .header-container { width: 100%; max-width: 330px; display: flex; flex-direction: column; gap: 3px; align-items: center; }
        .trust-banner { font-size: 7.5px; font-weight: 900; color: #fff; background: rgba(0,50,25,0.9); padding: 2px 5px; border-radius: 4px; border: 1px solid #ffd700; width: 100%; }
        .royal-main-title { font-size: 16px; font-weight: 900; color: #ffd700; text-shadow: 0 0 12px #ffd700; letter-spacing: 1px; }
        .login-card { background: rgba(2, 43, 16, 0.95); border: 2px solid #ffd700; padding: 10px; border-radius: 12px; width: 90%; max-width: 260px; box-shadow: 0 8px 25px rgba(0,0,0,0.9); }
        .login-card input { width: 100%; padding: 6px; margin: 2px 0; background: #000; border: 1.5px solid #ffd700; color: #ffd700; border-radius: 4px; font-size: 10px; text-align: center; font-weight: bold; }
        .login-btn { width: 100%; padding: 7px; margin-top: 3px; background: linear-gradient(135deg, #ffd700, #b8860b); color: #000; border: none; font-weight: 900; border-radius: 4px; cursor: pointer; font-size: 10px; text-transform: uppercase; }
        .login-btn.lobby { background: linear-gradient(135deg, #27ae60, #1e8449); color: #fff; }
        #gameLobbyScreen { 
            display: none; width: 100vw; height: 100vh; position: fixed; top: 0; left: 0; 
            background: radial-gradient(circle, #013b12 0%, #001205 100%); 
            z-index: 20000; flex-direction: column; justify-content: space-between; align-items: center; 
            padding: 3px 5px; overflow: hidden; 
        }
        .lobby-header { display: flex; justify-content: space-between; align-items: center; background: rgba(0, 26, 8, 0.95); border: 1.5px solid #ffd700; padding: 2px 6px; border-radius: 5px; width: 100%; max-width: 400px; flex-shrink: 0; }
        .user-profile-widget { display: flex; align-items: center; gap: 3px; background: rgba(0,20,8,0.9); border: 1px solid #ffd700; padding: 2px 5px; border-radius: 6px; cursor: pointer; }
        .user-avatar-circle { width: 22px; height: 22px; border-radius: 50%; background: #ffd700; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: bold; color: #000; }
        .wallet-btn-rect { background: linear-gradient(135deg, #27ae60, #1e8449); color: #fff; border: 1px solid #ffd700; padding: 4px 8px; border-radius: 4px; font-size: 9px; font-weight: 900; cursor: pointer; text-transform: uppercase; flex-shrink: 0; }
        .wallet-btn-rect.withdraw { background: linear-gradient(135deg, #c0392b, #962d22); }
        .timer-strip-center { 
            background: radial-gradient(circle at center, #2c0b0e 0%, #0f0203 100%); 
            color: #fff; padding: 2px 6px; border-radius: 4px; border: 1px solid #ffd700; 
            width: 70px; text-align: center; display: flex; flex-direction: column; justify-content: center; align-items: center; flex-shrink: 0;
        }
        .timer-main-val { font-size: 12px; font-weight: 900; line-height: 1; }
        .timer-sub-val { font-size: 4.5px; color: #ffcccc; font-weight: bold; }
        .history-strip-bar { display: flex; justify-content: center; align-items: center; gap: 3px; background: rgba(0, 15, 5, 0.95); border: 1px solid #ffd700; padding: 2px 5px; border-radius: 4px; width: 100%; max-width: 400px; flex-shrink: 0; }
        .history-title { font-size: 7.5px; font-weight: 900; color: #ffd700; margin-right: 2px; }
        .history-ball { width: 16px; height: 16px; border-radius: 50%; font-size: 8.5px; font-weight: 900; color: #fff; display: flex; align-items: center; justify-content: center; border: 1px solid #ffd700; flex-shrink: 0; }
        .history-ball.red { background: #b03a2e; }
        .history-ball.black { background: #0b0f15; }
        .history-ball.green { background: #27ae60; }
        .lobby-wheel-box { 
            position: relative; width: min(38vh, 180px); height: min(38vh, 180px); margin: 1px auto; 
            border: 3px solid #2ecc71; border-radius: 50%; background: radial-gradient(circle, #0a2e12 0%, #000 85%); 
            box-shadow: 0 0 20px rgba(46, 204, 113, 0.7); flex-shrink: 0; display: flex; align-items: center; justify-content: center; 
        }
        #lobbyWheelCanvas { width: 100% !important; height: 100% !important; object-fit: contain; border-radius: 50%; display: block; border: 1.5px solid #ffd700; }
        .wheel-center-graphic {
            position: absolute; top: 50%; left: 50%; width: 38px; height: 38px;
            transform: translate(-50%, -50%); background: radial-gradient(circle, #021a08 0%, #000 100%);
            border-radius: 50%; border: 1.5px solid #ffd700; z-index: 110;
            display: flex; flex-direction: column; justify-content: center; align-items: center; pointer-events: none;
        }
        .hub-text-royal, .hub-text-digital { font-size: 5px; font-weight: 900; color: #ffd700; line-height: 1; }
        .game-ball-orbit { position: absolute; top: 0; left: 0; width: 100%; height: 100%; border-radius: 50%; pointer-events: none; z-index: 120; transition: transform 5.0s cubic-bezier(0.15, 0.85, 0.12, 1.0); }
        .game-ball-orbit::after { content: ""; position: absolute; top: 3px; left: calc(50% - 4px); width: 8px; height: 8px; background: radial-gradient(circle, #fff 0%, #00ffcc 60%, #ff0055 100%); border-radius: 50%; box-shadow: 0 0 8px #fff; }
        .betting-board-section { background: rgba(1, 35, 12, 0.98); border-radius: 6px; padding: 2px 5px; width: 100%; max-width: 400px; display: flex; flex-direction: column; gap: 1.5px; border: 1.5px solid #ffd700; flex-shrink: 0; }
        .grid-table { display: grid; grid-template-columns: repeat(12, 1fr); gap: 1px; }
        .table-cell { background: linear-gradient(135deg, #042e12, #011506); border: 1px solid #d4af37; color: #e0e0e0; font-size: 9.5px; font-weight: 900; padding: 3px 0; border-radius: 2px; cursor: pointer; text-align: center; position: relative; }
        .table-cell.red { background: linear-gradient(135deg, #8a251d, #52130e); border-color: #e74c3c; }
        .table-cell.black { background: linear-gradient(135deg, #111822, #06090d); border-color: #555; }
        .table-cell.has-bet, .color-btn.has-bet, .group-btn.has-bet { border: 1.5px solid #fff !important; box-shadow: 0 0 8px #f1c40f; }
        .cell-badge { position: absolute; top: -3px; right: -2px; background: #f1c40f; color: #000; font-size: 6px; font-weight: 900; padding: 0.5px 1.5px; border-radius: 50%; z-index: 10; }
        .group-buttons-row-1 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.5px; width: 100%; }
        .group-buttons-row-2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1.5px; width: 100%; }
        .group-btn { background: #07100b; border: 1px solid #d4af37; color: #ffd700; font-size: 8px; font-weight: 900; padding: 2.5px 1px; border-radius: 2px; cursor: pointer; text-transform: uppercase; }
        .color-row { display: flex; gap: 1.5px; width: 100%; }
        .color-btn { flex: 1; padding: 2.5px 1px; font-weight: 900; font-size: 8.5px; border-radius: 2px; border: 1px solid #ffd700; cursor: pointer; color: #fff; text-transform: uppercase; }
        .btn-red { background: #962d22; }
        .btn-green { background: #1e8449; }
        .btn-black { background: #1b2631; }
        .chip-selector-row { display: flex; justify-content: center; gap: 3px; align-items: center; width: 100%; }
        .chip-item { width: 20px; height: 20px; border-radius: 50%; border: 1px dashed #ffd700; font-weight: 900; font-size: 8px; display: flex; align-items: center; justify-content: center; cursor: pointer; color: #fff; background: #111; }
        .chip-item.selected { border: 1.5px solid #fff; transform: scale(1.1); box-shadow: 0 0 8px #ffd700; }
        .chip-10 { background: #b03a2e; } .chip-50 { background: #2471a3; } .chip-100 { background: #27ae60; } .chip-500 { background: #7d3c98; } .chip-1000 { background: #d4af37; color: #000; }
        .transfer-btn-small { background: #2980b9; color: #fff; border: 1px solid #ffd700; padding: 2px 4px; border-radius: 2px; font-size: 7px; font-weight: bold; cursor: pointer; }
        .lobby-action-row { display: flex; justify-content: space-between; align-items: center; gap: 2px; width: 100%; }
        .status-msg-box { background: #f1c40f; color: #000; border: 1px solid #fff; padding: 2px 3px; font-size: 7.5px; font-weight: 900; border-radius: 3px; flex-grow: 1; text-align: center; }
        .clear-btn { background: #c0392b; color: #fff; padding: 2px 5px; font-size: 7.5px; font-weight: 900; border-radius: 2px; cursor: pointer; border: 1px solid #ffd700; }
        .mode-toggle-bar { display: flex; justify-content: center; gap: 2px; background: #000; border: 1px solid #ffd700; padding: 1px; border-radius: 3px; width: 100%; }
        .mode-btn { flex: 1; padding: 1.5px; font-size: 7.5px; font-weight: bold; border: none; border-radius: 2px; cursor: pointer; background: #111; color: #888; }
        .mode-btn.active-real { background: #27ae60; color: #fff; }
        .mode-btn.active-test { background: #2980b9; color: #fff; }
        .wallet-modal { display: none; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.9); z-index: 30000; align-items: center; justify-content: center; padding: 8px; }
        .wallet-modal-content { background: radial-gradient(circle, #023814 0%, #000 100%); border: 3px solid #ffd700; padding: 12px; border-radius: 12px; width: 100%; max-width: 320px; text-align: center; color: #fff; max-height: 90vh; overflow-y: auto; }
        .withdraw-packages-grid, .deposit-packages-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin: 5px 0; }
        .dep-pkg-btn, .wd-pkg-btn { background: #000; border: 1px solid #ffd700; color: #ffd700; padding: 6px 0; font-weight: bold; font-size: 9.5px; border-radius: 3px; cursor: pointer; }
        .dep-pkg-btn.selected, .wd-pkg-btn.selected { background: #ffd700; color: #000; }
        .wallet-modal-content input { width: 100%; padding: 7px; margin: 3px 0; background: #000; border: 1.5px solid #ffd700; color: #ffd700; border-radius: 4px; text-align: center; font-weight: bold; font-size: 10.5px; }
        #secretAdminModal { display: none; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: #020f06; z-index: 2147483647 !important; padding: 8px; text-align: center; color: #fff; overflow-y: auto; }
        .admin-dashboard-container { max-width: 750px; margin: 0 auto; background: #000; border: 2px solid #ffd700; border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 8px; text-align: left; }
        .admin-section-box { background: rgba(0,0,0,0.8); border: 1px solid rgba(255,215,0,0.3); padding: 8px; border-radius: 6px; font-size: 10px; }
        .req-table-row { background: #0b1c11; border: 1px solid #333; padding: 5px 8px; border-radius: 4px; margin-bottom: 3px; display: flex; justify-content: space-between; align-items: center; font-size: 9.5px; }
        .req-actions button { padding: 3px 6px; font-weight: bold; border-radius: 3px; border: none; cursor: pointer; font-size: 8.5px; }
    </style>

    <script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
    <script src="https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js"></script>
    <script src="https://www.gstatic.com/firebasejs/9.23.0/firebase-database-compat.js"></script>
</head>
<body>

    <audio id="bgmAudio" loop preload="auto"><source src="https://cdn.pixabay.com/download/audio/2022/05/27/audio_1808fbf07a.mp3" type="audio/mpeg"></audio>
    <audio id="ballRollSfx" loop preload="auto"><source src="https://assets.mixkit.co/active_storage/sfx/2020/2020-preview.mp3" type="audio/mpeg"></audio>
    <audio id="ballDropSfx" preload="auto"><source src="https://assets.mixkit.co/active_storage/sfx/2578/2578-preview.mp3" type="audio/mpeg"></audio>

    <div id="customAlertModal" style="display:none; position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.85); z-index:900000; align-items:center; justify-content:center; padding:15px;">
        <div style="background:#034519; border:3px solid #ffd700; padding:18px; border-radius:12px; width:100%; max-width:260px; text-align:center;">
            <h3 style="color:#ffd700; font-size:14px; margin-bottom:5px;">NOTICE</h3>
            <p id="customAlertMessage" style="font-size:10.5px; color:#fff; font-weight:bold; margin-bottom:10px;"></p>
            <button onclick="closeCustomAlert()" class="login-btn lobby" style="padding:7px; font-size:9.5px;">OK</button>
        </div>
    </div>

    <div id="adminPinModal" style="display:none; position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.9); z-index:200000; align-items:center; justify-content:center; padding:15px;">
        <div style="background:#011c08; border:3px solid #ffd700; padding:16px; border-radius:12px; width:100%; max-width:250px; text-align:center;">
            <h3 style="color:#ffd700; font-size:13px; margin-bottom:5px;">ADMIN PIN</h3>
            <input type="password" id="adminSecretPassInput" placeholder="Enter PIN" maxlength="6" style="width:100%; padding:6px; background:#000; color:#ffd700; border:1px solid #ffd700; text-align:center; font-weight:bold; border-radius:4px; margin-bottom:7px;">
            <div style="display:flex; gap:5px;">
                <button onclick="verifyAdminPinCode()" class="login-btn lobby" style="padding:6px; font-size:9.5px;">Unlock</button>
                <button onclick="document.getElementById('adminPinModal').style.display='none'" style="background:#c0392b; color:#fff; border:none; padding:6px; border-radius:4px; font-size:9.5px; font-weight:bold; flex:1; cursor:pointer;">Cancel</button>
            </div>
        </div>
    </div>

    <div id="supportTicketModal" class="wallet-modal">
        <div class="wallet-modal-content" style="max-width:300px;">
            <h3 style="color:#ffd700; margin-bottom:5px; font-size:13px;">SUPPORT DESK</h3>
            <textarea id="supportUserMessageInput" placeholder="Describe your issue..." style="width:100%; height:75px; background:#000; color:#ffd700; border:1px solid #ffd700; padding:5px; border-radius:4px; font-size:9.5px; resize:none; margin-bottom:5px;"></textarea>
            <button onclick="submitSupportTicket()" class="login-btn lobby" style="padding:7px; font-size:9.5px;">Send Ticket</button>
            <button onclick="document.getElementById('supportTicketModal').style.display='none'" style="background:#444; color:#fff; border:none; padding:6px; width:100%; border-radius:4px; margin-top:4px; font-size:9px; font-weight:bold; cursor:pointer;">Close</button>
        </div>
    </div>

    <script>
        function showCustomAlert(msg) { document.getElementById('customAlertMessage').innerText = msg; document.getElementById('customAlertModal').style.display = 'flex'; }
        function closeCustomAlert() { document.getElementById('customAlertModal').style.display = 'none'; }
    </script>

    <div id="comingSoonNoticeModal" style="display:flex; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.85); z-index:70000; align-items:center; justify-content:center;">
        <div style="background:#0b2d13; border:3px solid #ffd700; padding:16px; border-radius:14px; width:270px; text-align:center; color:#fff;">
            <h3 style="color:#ffd700; font-size:15px; margin-bottom:4px;">ROYAL CASINO</h3>
            <p style="font-size:9.5px; color:#fff; font-weight:bold; margin-bottom:5px;">100% SECURE & LIVE</p>
            <div style="background:#c0392b; color:#fff; font-size:9.5px; font-weight:bold; padding:4px; border-radius:4px; margin-bottom:5px; text-transform:uppercase;">🔥 7 PLAYER LIVE TABLE 🔥</div>
            <button onclick="closeComingSoonModal(); playMasterAudio();" style="background:linear-gradient(135deg, #ffd700, #b8860b); color:#000; border:none; padding:7px 18px; border-radius:5px; font-weight:900; font-size:10px; cursor:pointer; text-transform:uppercase;">Enter Lobby</button>
        </div>
    </div>

    <div id="fullscreenWheelBg">
        <div class="bg-wheel-wrap"><canvas id="loginWheelCanvasBg" width="300" height="300"></canvas></div>
    </div>

    <div id="loginScreenContainer">
        <div class="header-container">
            <div class="trust-banner">ROYAL LIVE PLATFORM • ⚡</div>
            <div class="royal-main-title">ROYAL ROULETTE</div>
        </div>
        <div class="login-card">
            <h3 style="color:#ffd700; font-size:10.5px; margin-bottom:2px;">CLOUD LOGIN</h3>
            <input type="tel" id="inputPhone" placeholder="Mobile Number (10 Digits)" maxlength="10">
            <input type="password" id="inputMpin" placeholder="Enter 4-Digit MPIN" maxlength="4">
            <input type="text" id="inputOtp" placeholder="OTP Code" maxlength="15">
            <button class="login-btn" onclick="requestStrictOtp()">GET OTP</button>
            <button class="login-btn lobby" onclick="verifyCloudWalletLogin(); playMasterAudio();">ENTER LOBBY</button>
        </div>
        <div style="width:100%; max-width:280px;">
            <a onclick="openSupportModal();" style="display:inline-block; padding:2px 6px; background:#0088cc; color:#fff; text-decoration:none; font-weight:bold; border-radius:8px; font-size:7px; cursor:pointer;">🎧 Support Ticket</a>
        </div>
    </div>

    <div id="gameLobbyScreen">
        <div class="lobby-header">
            <div class="user-profile-widget" onclick="handleProfileClick(); event.stopPropagation();">
                <div class="user-avatar-circle" id="userAvatarEmoji">😎</div>
                <div>
                    <div style="font-size:6.5px; font-weight:900; color:#ffd700;" id="userDisplayPhone">RD001001</div>
                    <div style="font-size:5px; color:#2ecc71;">Profile 👆</div>
                </div>
            </div>
            <button class="wallet-btn-rect" onclick="openDepositModal(); event.stopPropagation();">DEPOSIT</button>
            <div class="timer-strip-center">
                <span class="timer-main-val" id="lobbyTimerMain">02:00</span>
                <span class="timer-sub-val" id="lobbyTimerSub">OPEN</span>
            </div>
            <button class="wallet-btn-rect withdraw" onclick="openWithdrawModal(); event.stopPropagation();">WITHDRAW</button>
        </div>

        <div class="history-strip-bar">
            <span class="history-title">History:</span>
            <div id="historyBallsContainer" style="display: flex; gap: 2px;"></div>
        </div>

        <div class="lobby-wheel-box">
            <canvas id="lobbyWheelCanvas" width="180" height="180"></canvas>
            <div class="wheel-center-graphic">
                <div class="hub-text-royal">ROYAL</div>
                <div class="hub-text-digital">DIGITAL</div>
            </div>
            <div class="game-ball-orbit" id="rouletteBallOrbit"></div>
        </div>

        <div class="betting-board-section">
            <div style="background: rgba(0,0,0,0.85); padding: 1px 3px; border-radius: 3px; display: flex; justify-content: space-between; align-items: center; font-size: 7.5px; font-weight: 900; color: #ffd700;">
                <span>Bet: <span id="lobbyTotalBet" style="color:#fff;">0</span></span>
                <span>REAL: <span id="playerRealBal" style="color:#2ecc71;">₹0</span> | TEST: <span id="playerTestBal" style="color:#3498db;">10000</span></span>
            </div>

            <div class="mode-toggle-bar">
                <button class="mode-btn active-test" id="modeBtnTest" onclick="window.switchGameMode('test')">🧪 Test</button>
                <button class="mode-btn" id="modeBtnReal" onclick="window.switchGameMode('real')">💎 Real</button>
            </div>
            
            <div class="grid-table" id="gridTableDiv"></div>

            <div class="group-buttons-row-1">
                <button class="group-btn" onclick="placeGroupBet('dozen_1', [1,2,3,4,5,6,7,8,9,10,11,12], this)">1st 12</button>
                <button class="group-btn" onclick="placeGroupBet('dozen_2', [13,14,15,16,17,18,19,20,21,22,23,24], this)">2nd 12</button>
                <button class="group-btn" onclick="placeGroupBet('dozen_3', [25,26,27,28,29,30,31,32,33,34,35,36], this)">3rd 12</button>
            </div>
            <div class="group-buttons-row-2">
                <button class="group-btn" onclick="placeGroupBet('half_1_18', [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18], this)">1 - 18</button>
                <button class="group-btn" onclick="placeGroupBet('half_19_36', [19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36], this)">19 - 36</button>
            </div>
            
            <div class="color-row">
                <button class="color-btn btn-red" id="btnColorRed" onclick="placeTableBet('red', this)">RED</button>
                <button class="color-btn btn-green" id="btnColorGreen" onclick="placeTableBet('0', this)">ZERO</button>
                <button class="color-btn btn-black" id="btnColorBlack" onclick="placeTableBet('black', this)">BLACK</button>
            </div>

            <div class="chip-selector-row">
                <div class="chip-item chip-10" onclick="selectChip(10, this)">10</div>
                <div class="chip-item chip-50 selected" onclick="selectChip(50, this)">50</div>
                <div class="chip-item chip-100" onclick="selectChip(100, this)">100</div>
                <div class="chip-item chip-500" onclick="selectChip(500, this)">500</div>
                <div class="chip-item chip-1000" onclick="selectChip(1000, this)">1K</div>
                <button class="transfer-btn-small" onclick="openTransferModal(); event.stopPropagation();">⇄ Transfer</button>
            </div>
            
            <div class="lobby-action-row">
                <button class="clear-btn" onclick="clearTableBets()">Clear / Undo</button>
                <div class="status-msg-box" id="lobbyStatusMsg">Connecting...</div>
                <button class="clear-btn" style="background:#b03a2e;" onclick="logoutToLogin()">Logout</button>
            </div>
        </div>
    </div>

    <div id="playerProfileModal" class="wallet-modal">
        <div class="wallet-modal-content">
            <h3 style="color:#ffd700; margin-bottom:3px; font-size:13px;">VIP PASSBOOK</h3>
            <div style="background:#000; border:1px solid #ffd700; padding:5px; border-radius:5px; text-align:left; font-size:9px; margin-bottom:4px;">
                <div>📱 Mobile: <span id="profPhone">--</span></div>
                <div>🆔 VIP ID: <span id="profVipId">--</span></div>
                <div>💎 Real Bal: ₹<span id="profRealBal">0</span></div>
            </div>
            <div id="adminDirectAccessBtnWrap" style="display:none; margin-bottom:4px;">
                <button onclick="document.getElementById('playerProfileModal').style.display='none'; openAdminPanelDirectly();" style="width:100%; padding:6px; background:#ffd700; color:#000; font-weight:900; border:none; border-radius:3px; font-size:9.5px;">👑 ADMIN PANEL</button>
            </div>
            <div style="background:rgba(0,20,8,0.95); border:1px solid #2ecc71; border-radius:5px; padding:5px; text-align:left; max-height:120px; overflow-y:auto;" id="playerLedgerListContainer">
                <div style="color:#888; text-align:center;">Loading passbook...</div>
            </div>
            <button onclick="closeWalletModals()" class="login-btn" style="padding:6px; font-size:9.5px; margin-top:4px;">Close</button>
        </div>
    </div>

    <div id="secretAdminModal">
        <div class="admin-dashboard-container">
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #ffd700; padding-bottom:6px;">
                <h2 style="font-size:13px; color:#ffd700;">ADMIN CONTROL PANEL</h2>
                <button onclick="document.getElementById('secretAdminModal').style.display='none'" style="background:#e74c3c; color:#fff; border:none; padding:3px 8px; border-radius:3px; font-size:9.5px;">✕ Close</button>
            </div>
            <div class="admin-section-box">
                <div style="color:#3498db; font-weight:bold; margin-bottom:3px;">🎧 SUPPORT TICKETS</div>
                <div id="adminSupportTicketsList" style="max-height:90px; overflow-y:auto;">No tickets.</div>
            </div>
            <div class="admin-section-box">
                <div style="color:#2ecc71; font-weight:bold; margin-bottom:3px;">🟢 LIVE PLAYERS</div>
                <div id="adminLiveOnlinePlayersList" style="max-height:70px; overflow-y:auto;">Waiting...</div>
            </div>
            <div class="admin-section-box">
                <div style="color:#ffd700; font-weight:bold; margin-bottom:3px;">⚙️ RIG WINNING NUMBER</div>
                <select id="adminRigSelect" style="width:100%; padding:5px; background:#000; color:#ffd700; border:1px solid #ffd700; font-size:9.5px; margin-bottom:4px;">
                    <option value="random">Auto 5% Safe Engine (Random)</option>
                </select>
                <button onclick="saveAdminSettings()" class="login-btn lobby" style="padding:6px; font-size:9.5px;">Push Rig Number</button>
            </div>
            <div class="admin-section-box">
                <div style="color:#ffd700; font-weight:bold; margin-bottom:3px;">📥 DEPOSITS</div>
                <div id="admDepositList" style="max-height:90px; overflow-y:auto;">No deposits.</div>
            </div>
            <div class="admin-section-box">
                <div style="color:#ffd700; font-weight:bold; margin-bottom:3px;">📤 WITHDRAWALS</div>
                <div id="admWithdrawList" style="max-height:90px; overflow-y:auto;">No withdrawals.</div>
            </div>
        </div>
    </div>

    <div id="depositModalBox" class="wallet-modal">
        <div class="wallet-modal-content">
            <h3 style="color:#ffd700; font-size:13px; margin-bottom:5px;">DEPOSIT GATEWAY</h3>
            <input type="number" id="customDepositInput" value="300" placeholder="Amount">
            <img id="dynamicPlayerQrImg" src="https://i.ibb.co/3yk54L2/1000532596.jpg" style="width:100px; height:100px; object-fit:contain; margin:4px 0; border:2px solid #ffd700; background:#fff;" />
            <input type="text" id="depositUtrInput" placeholder="12-Digit UTR">
            <input type="file" id="depositProofFileInput" accept="image/*" style="display:none;" onchange="handleDepositScreenshotUpload(this)">
            <button onclick="document.getElementById('depositProofFileInput').click()" style="width:100%; padding:5px; background:#2980b9; color:#fff; border:none; border-radius:3px; font-size:9px; margin-bottom:4px; font-weight:bold;">📸 Upload Screenshot</button>
            <button onclick="triggerCloudDepositSubmit();" class="login-btn lobby" style="padding:7px; font-size:9.5px;">Submit Deposit</button>
            <button onclick="closeWalletModals()" style="background:#333; color:#ccc; border:none; padding:5px; width:100%; border-radius:3px; margin-top:4px; font-size:9px;">Close</button>
        </div>
    </div>

    <div id="withdrawModalBox" class="wallet-modal">
        <div class="wallet-modal-content">
            <h3 style="color:#ffd700; font-size:13px; margin-bottom:5px;">WITHDRAWAL GATEWAY</h3>
            <input type="number" id="withdrawAmtInput" value="500" placeholder="Amount">
            <input type="text" id="withdrawUpiInput" placeholder="UPI ID (e.g. user@paytm)">
            <button onclick="triggerCloudSubmitWithdraw()" class="login-btn" style="background:#e74c3c; padding:7px; font-size:9.5px; margin-top:4px;">Request Payout</button>
            <button onclick="closeWalletModals()" style="background:#333; color:#ccc; border:none; padding:5px; width:100%; border-radius:3px; margin-top:4px; font-size:9px;">Close</button>
        </div>
    </div>

    <div id="transferModalBox" class="wallet-modal">
        <div class="wallet-modal-content">
            <h3 style="color:#ffd700; font-size:13px; margin-bottom:5px;">TRANSFER COINS</h3>
            <input type="text" id="transferTargetPhone" placeholder="Friend's Mobile">
            <input type="number" id="transferCoinAmt" placeholder="Amount">
            <button onclick="executeCoinTransferCloud()" class="login-btn" style="background:#2980b9; padding:7px; font-size:9.5px; margin-top:4px;">Transfer</button>
            <button onclick="closeWalletModals()" style="background:#444; color:#fff; border:none; padding:5px; width:100%; border-radius:3px; margin-top:4px; font-size:9px;">Close</button>
        </div>
    </div>

    <div id="cinematicResultPopup" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.85); z-index:50000; flex-direction:column; align-items:center; justify-content:center;">
        <div style="background:#034519; border:3px solid #f1c40f; padding:16px; border-radius:14px; width:240px; text-align:center;">
            <h3 style="color:#f1c40f; font-size:13px; margin-bottom:3px;">WINNING NUMBER</h3>
            <div id="popupWinningNumDisplay" style="font-size:32px; font-weight:900; color:#fff; margin:6px 0;">14 RED</div>
            <div id="popupPayoutDisplay" style="font-size:10px; font-weight:bold; color:#00ffff;">You Won!</div>
        </div>
    </div>

    <script>
        const masterRoot = firebase.database().ref("royal_roulette_master_cloud_v23");
        const qrRef = masterRoot.child("qr_url");
        const rigRef = masterRoot.child("winning_number");
        const historyRef = masterRoot.child("history_list");
        const livePlayersRef = masterRoot.child("active_online_players");
        const usersRef = masterRoot.child("users");
        const depositsRef = masterRoot.child("deposit_requests");
        const withdrawsRef = masterRoot.child("withdraw_requests");
        const activeResultRef = masterRoot.child("current_round_result");
        const supportTicketsRef = masterRoot.child("support_tickets");

        const numbersList = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
        const redList = [32, 19, 21, 25, 34, 27, 36, 30, 23, 5, 16, 1, 14, 9, 18, 7, 12, 3];
        const MASTER_ADMIN_PHONE = "8889865182";
        const SECURE_ADMIN_PIN = "888651";

        let accumulatedBallRotation = 0;
        let realCoins = 0, testCoins = 10000, activeGameMode = 'test';
        let loggedUserPhone = "", loggedVipId = "RD001001";
        let isGameSpinning = false;
        let myActiveBets = {}, currentTotalBet = 0, betHistoryStack = [];
        let activeRoundId = 0;
        let processedResultRoundId = null;
        let userDepositScreenshotData = "";

        window.globalState = { adminQrUrl: "https://i.ibb.co/3yk54L2/1000532596.jpg", historyList: [24, 14, 5, 22, 10, 3] };

        window.addEventListener('DOMContentLoaded', () => {
            drawCanvasWheel('loginWheelCanvasBg', 50, 13);
            drawCanvasWheel('lobbyWheelCanvas', 40, 10);
            
            const adminSelect = document.getElementById('adminRigSelect');
            if (adminSelect) {
                numbersList.forEach(num => { 
                    let opt = document.createElement('option'); 
                    opt.value = num; 
                    opt.innerText = "Rig Number " + num; 
                    adminSelect.appendChild(opt); 
                });
            }
        });

        qrRef.on("value", (snap) => { if (snap.val()) window.globalState.adminQrUrl = snap.val(); });
        historyRef.on("value", (snap) => { if (snap.val()) { window.globalState.historyList = snap.val(); renderHistoryBarUI(); } });

        activeResultRef.on("value", (snap) => {
            let res = snap.val();
            if (!res || processedResultRoundId === res.roundId) return;
            processedResultRoundId = res.roundId;
            executeClientGlobalSpinAnimation(res.winningNum, res.roundId);
        });

        supportTicketsRef.on("value", (snap) => {
            let tickets = snap.val() || {}, listEl = document.getElementById('adminSupportTicketsList'), html = "";
            if (!listEl) return;
            Object.keys(tickets).forEach(k => {
                let t = tickets[k];
                if (t.status === 'Pending') {
                    html += \`<div style="background:#000; padding:4px; border-radius:3px; margin-bottom:2px; font-size:9px;">
                        <b>\${t.phone}</b>: "\${t.message}"
                        <button onclick="supportTicketsRef.child('\${k}').update({status:'Resolved'})" style="background:#27ae60; color:#fff; border:none; padding:2px 4px; margin-left:4px; border-radius:2px; cursor:pointer;">Resolve</button>
                    </div>\`;
                }
            });
            listEl.innerHTML = html || "No tickets.";
        });

        livePlayersRef.on("value", (snap) => {
            let players = snap.val() || {}, listEl = document.getElementById('adminLiveOnlinePlayersList'), html = "", now = Date.now();
            if (!listEl) return;
            Object.values(players).forEach(p => {
                if (now - p.lastSeen < 4000) {
                    html += \`<div style="font-size:9px; color:#2ecc71;">📱 \${p.phone} (\${p.vipId}) - ₹\${p.balance}</div>\`;
                }
            });
            listEl.innerHTML = html || "No online users.";
        });

        depositsRef.on("value", (snap) => {
            let deps = snap.val() || {}, listEl = document.getElementById('admDepositList'), html = "";
            if (!listEl) return;
            Object.keys(deps).forEach(key => {
                let d = deps[key];
                if (d.status === 'Pending') {
                    html += \`<div class="req-table-row"><span>\${d.phone} - ₹\${d.amount} (UTR: \${d.utr})</span>
                    <div class="req-actions"><button style="background:#27ae60; color:#fff;" onclick="approveCloudDeposit('\${key}', '\${d.phone}', \${d.amount})">Approve</button></div></div>\`;
                }
            });
            listEl.innerHTML = html || "No pending deposits.";
        });

        withdrawsRef.on("value", (snap) => {
            let wds = snap.val() || {}, listEl = document.getElementById('admWithdrawList'), html = "";
            if (!listEl) return;
            Object.keys(wds).forEach(key => {
                let w = wds[key];
                if (w.status === 'Pending') {
                    html += \`<div class="req-table-row"><span>\${w.phone} - ₹\${w.amount}</span>
                    <div class="req-actions"><button style="background:#27ae60; color:#fff;" onclick="withdrawsRef.child('\${key}').update({status:'Approved'})">Pay</button></div></div>\`;
                }
            });
            listEl.innerHTML = html || "No pending withdrawals.";
        });

        window.openSupportModal = function() { document.getElementById('supportUserMessageInput').value = ""; document.getElementById('supportTicketModal').style.display = 'flex'; };
        window.submitSupportTicket = function() {
            let msg = document.getElementById('supportUserMessageInput').value.trim();
            if (!msg || !loggedUserPhone) { showCustomAlert("Enter message & login first!"); return; }
            supportTicketsRef.push({ phone: loggedUserPhone, vipId: loggedVipId, message: msg, status: 'Pending', timestamp: Date.now() }).then(() => {
                document.getElementById('supportTicketModal').style.display = 'none';
                showCustomAlert("✅ Support ticket sent!");
            });
        };

        function bindUserCloudWallet(phone) {
            usersRef.child(phone).on("value", (snap) => {
                let data = snap.val() || {};
                realCoins = data.balance || 0;
                loggedVipId = data.vipId || ("RD00" + phone.slice(-4));
                updateBalancesDisplay();
            });
            loadPlayerPassbook(phone);
        }

        // 🟢 फायरबेस डेटाबेस से रियल-टाइम बेट्स सिंक लिसनर
        function setupGlobalRoundBetsListener(roundId, phone) {
            if (!roundId || !phone) return;
            masterRoot.child("live_rounds/" + roundId + "/bets/" + phone).on("value", (snapshot) => {
                let bets = snapshot.val() || {};
                myActiveBets = bets;
                currentTotalBet = 0;
                
                document.querySelectorAll('.table-cell, .color-btn, .group-btn').forEach(c => {
                    c.classList.remove('has-bet');
                    let b = c.querySelector('.cell-badge');
                    if (b) b.remove();
                });

                Object.keys(bets).forEach(key => {
                    let amt = bets[key];
                    currentTotalBet += amt;
                    let cell = null;
                    if (key === 'red') cell = document.getElementById('btnColorRed');
                    else if (key === 'black') cell = document.getElementById('btnColorBlack');
                    else if (key === '0') cell = document.getElementById('btnColorGreen');
                    else {
                        cell = Array.from(document.querySelectorAll('.table-cell')).find(el => el.innerText.trim() === key);
                    }

                    if (cell) {
                        cell.classList.add('has-bet');
                        let b = cell.querySelector('.cell-badge');
                        if (!b) { b = document.createElement('div'); b.className = 'cell-badge'; cell.appendChild(b); }
                        b.innerText = amt;
                    }
                });
                let totalBetEl = document.getElementById('lobbyTotalBet');
                if (totalBetEl) totalBetEl.innerText = currentTotalBet;
            });
        }

        function loadPlayerPassbook(phone) {
            if (!phone) return;
            usersRef.child(phone + "/ledger").limitToLast(20).on("value", (snapshot) => {
                let ledger = snapshot.val() || {}, container = document.getElementById('playerLedgerListContainer'), html = "";
                Object.values(ledger).reverse().forEach(item => {
                    let col = item.amount > 0 ? "#2ecc71" : "#e74c3c";
                    html += \`<div style="font-size:8.5px; border-bottom:1px dashed #333; padding:2px 0;"><b>\${item.description || item.sourceType}</b>: <span style="color:\${col};">\${item.amount > 0 ? '+' : ''}₹\${item.amount}</span></div>\`;
                });
                container.innerHTML = html || "No transactions.";
            });
        }

        window.handleProfileClick = function() {
            document.getElementById('adminDirectAccessBtnWrap').style.display = (loggedUserPhone === MASTER_ADMIN_PHONE) ? 'block' : 'none';
            document.getElementById('profPhone').innerText = loggedUserPhone;
            document.getElementById('profVipId').innerText = loggedVipId;
            document.getElementById('profRealBal').innerText = realCoins;
            document.getElementById('playerProfileModal').style.display = 'flex';
        };

        window.openAdminPanelDirectly = function() { document.getElementById('secretAdminModal').style.display = 'flex'; };
        window.verifyAdminPinCode = function() {
            if (document.getElementById('adminSecretPassInput').value.trim() === SECURE_ADMIN_PIN) {
                document.getElementById('adminPinModal').style.display = 'none';
                document.getElementById('secretAdminModal').style.display = 'flex';
            } else { showCustomAlert("❌ Wrong PIN!"); }
        };

        window.playMasterAudio = function() { let bgm = document.getElementById('bgmAudio'); if (bgm) { bgm.volume = 0.3; bgm.play().catch(e => {}); } };

        window.verifyCloudWalletLogin = function() {
            let phone = document.getElementById('inputPhone').value.trim();
            let mpin = document.getElementById('inputMpin').value.trim();
            if (phone.length < 10) { showCustomAlert("Enter 10-digit number!"); return; }

            usersRef.child(phone).once("value", (snapshot) => {
                let data = snapshot.val() || {};
                if (data.mpin && data.mpin !== mpin) { showCustomAlert("❌ Incorrect MPIN!"); return; }

                usersRef.child(phone).update({
                    phone: phone, vipId: data.vipId || ("RD00" + phone.slice(-4)),
                    mpin: mpin || data.mpin || "1234", balance: data.balance !== undefined ? data.balance : 0
                }).then(() => {
                    loggedUserPhone = phone;
                    bindUserCloudWallet(phone);
                    document.getElementById('fullscreenWheelBg').style.display = 'none';
                    document.getElementById('loginScreenContainer').style.display = 'none';
                    document.getElementById('gameLobbyScreen').style.display = 'flex';
                });
            });
        };

        window.updateBalancesDisplay = function() {
            document.getElementById('playerRealBal').innerText = "₹" + realCoins;
            document.getElementById('playerTestBal').innerText = testCoins;
            document.getElementById('userDisplayPhone').innerText = loggedVipId;
        };

        window.switchGameMode = function(mode) {
            activeGameMode = mode;
            document.getElementById('modeBtnTest').className = mode === 'test' ? "mode-btn active-test" : "mode-btn";
            document.getElementById('modeBtnReal').className = mode === 'real' ? "mode-btn active-real" : "mode-btn";
        };

        const gridTableDiv = document.getElementById('gridTableDiv');
        if(gridTableDiv) {
            [[3,6,9,12,15,18,21,24,27,30,33,36],[2,5,8,11,14,17,20,23,26,29,32,35],[1,4,7,10,13,16,19,22,25,28,31,34]].forEach(row => {
                row.forEach(num => {
                    let cell = document.createElement('div');
                    cell.className = 'table-cell ' + (redList.includes(num) ? 'red' : 'black');
                    cell.innerText = num; 
                    cell.onclick = () => { window.placeTableBet(num.toString(), cell); };
                    gridTableDiv.appendChild(cell);
                });
            });
        }

        let currentActiveChip = 50;
        window.selectChip = function(val, el) { currentActiveChip = val; document.querySelectorAll('.chip-item').forEach(c => c.classList.remove('selected')); el.classList.add('selected'); };

        // 🟢 1 से 36 नंबर, रेड, ब्लैक, ज़ीरो पर अचूक बेटिंग (HTTP API)
        window.placeTableBet = function(key, el) {
            if (isGameSpinning) return;
            
            if (activeGameMode === 'real') { 
                if (realCoins < currentActiveChip) { showCustomAlert("Low Balance!"); return; } 
                
                fetch('/api/place-bet', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phone: loggedUserPhone, key: key, amount: currentActiveChip })
                })
                .then(res => res.json())
                .then(resp => {
                    if (resp && resp.success) {
                        realCoins = resp.newBalance;
                        updateBalancesDisplay();
                        betHistoryStack.push({ key: key, amount: currentActiveChip, mode: 'real' });
                        
                        if (el) {
                            el.classList.add('has-bet');
                            let b = el.querySelector('.cell-badge');
                            if (!b) { b = document.createElement('div'); b.className = 'cell-badge'; el.appendChild(b); }
                            let curAmt = parseInt(b.innerText) || 0;
                            b.innerText = curAmt + currentActiveChip;
                        }
                    } else {
                        showCustomAlert((resp && resp.msg) || "Bet failed!");
                    }
                }).catch(e => { showCustomAlert("Network error placing bet."); });
            } else { 
                if (testCoins < currentActiveChip) testCoins = 10000; 
                testCoins -= currentActiveChip; 
                myActiveBets[key] = (myActiveBets[key] || 0) + currentActiveChip;
                currentTotalBet += currentActiveChip;
                document.getElementById('lobbyTotalBet').innerText = currentTotalBet;

                betHistoryStack.push({ key: key, amount: currentActiveChip, mode: 'test' });
                if (el) { 
                    el.classList.add('has-bet'); 
                    let b = el.querySelector('.cell-badge'); 
                    if(!b){b=document.createElement('div');b.className='cell-badge';el.appendChild(b);} 
                    b.innerText = myActiveBets[key]; 
                }
            }
        };

        window.placeGroupBet = function(groupKey, numbersArray, el) {
            if (isGameSpinning) return;
            let totalNeeded = currentActiveChip * numbersArray.length;
            if (activeGameMode === 'real') {
                if (realCoins < totalNeeded) { showCustomAlert("Low Balance!"); return; }
                numbersArray.forEach(num => {
                    fetch('/api/place-bet', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ phone: loggedUserPhone, key: num.toString(), amount: currentActiveChip })
                    });
                });
                realCoins -= totalNeeded;
                updateBalancesDisplay();
                if (el) el.classList.add('has-bet');
            } else {
                if (testCoins < totalNeeded) testCoins = 10000;
                testCoins -= totalNeeded;
                numbersArray.forEach(num => { myActiveBets[num.toString()] = (myActiveBets[num.toString()] || 0) + currentActiveChip; });
                currentTotalBet += totalNeeded;
                document.getElementById('lobbyTotalBet').innerText = currentTotalBet;
                if (el) el.classList.add('has-bet');
            }
            betHistoryStack.push({ key: groupKey, amount: totalNeeded, mode: activeGameMode });
        };

        window.clearTableBets = function() {
            if (isGameSpinning || betHistoryStack.length === 0) return;
            let last = betHistoryStack.pop();
            
            if (last.mode === 'test') {
                testCoins += last.amount;
                currentTotalBet -= last.amount;
                document.getElementById('lobbyTotalBet').innerText = currentTotalBet;
                showCustomAlert("Last test bet undone!");
            } else if (last.mode === 'real') {
                fetch('/api/cancel-bet', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phone: loggedUserPhone, key: last.key, amount: last.amount, roundId: activeRoundId })
                })
                .then(res => res.json())
                .then(resp => {
                    if (resp && resp.success) {
                        realCoins = resp.newBalance;
                        updateBalancesDisplay();
                        showCustomAlert("✅ Last real bet undone & refunded!");
                    } else {
                        showCustomAlert((resp && resp.msg) || "Cannot undo bet at this moment.");
                    }
                }).catch(e => { showCustomAlert("Network error during undo."); });
            }
        };

        masterRoot.child("game_state/timer").on("value", (snap) => {
            let timerData = snap.val();
            if (!timerData) return;
            if (timerData.roundId !== activeRoundId) {
                activeRoundId = timerData.roundId;
                myActiveBets = {}; currentTotalBet = 0; betHistoryStack = [];
                document.getElementById('lobbyTotalBet').innerText = 0;
                if (loggedUserPhone) setupGlobalRoundBetsListener(activeRoundId, loggedUserPhone);
            }
            let m = Math.floor(timerData.timeLeft / 60), s = timerData.timeLeft % 60;
            document.getElementById('lobbyTimerMain').innerText = \`\${m<10?'0':''}\${m}:\${s<10?'0':''}\${s}\`;
            renderHistoryBarUI();
        });

        function renderHistoryBarUI() {
            let html = "";
            if (window.globalState.historyList) {
                window.globalState.historyList.forEach(num => {
                    let cls = num === 0 ? 'green' : (redList.includes(num) ? 'red' : 'black');
                    html += \`<div class="history-ball \${cls}">\${num}</div>\`;
                });
            }
            let cont = document.getElementById('historyBallsContainer');
            if(cont) cont.innerHTML = html;
        }

        function executeClientGlobalSpinAnimation(winningNum, endedRoundId) {
            isGameSpinning = true; 
            document.getElementById('lobbyStatusMsg').innerText = "Spinning...";
            let ballRollAudio = document.getElementById('ballRollSfx');
            if (ballRollAudio) { ballRollAudio.currentTime = 0; ballRollAudio.play().catch(e => {}); }

            let totalPockets = numbersList.length;
            let targetAngle = numbersList.indexOf(winningNum) * (360 / totalPockets) + ((360 / totalPockets) / 2);
            accumulatedBallRotation += 1800 + (360 - (accumulatedBallRotation % 360)) + targetAngle;
            const ballOrbitEl = document.getElementById('rouletteBallOrbit');
            if(ballOrbitEl) ballOrbitEl.style.transform = \`rotate(\${accumulatedBallRotation}deg)\`;

            setTimeout(() => {
                if (ballRollAudio) ballRollAudio.pause();
                let ballDropAudio = document.getElementById('ballDropSfx');
                if (ballDropAudio) { ballDropAudio.currentTime = 0; ballDropAudio.play().catch(e => {}); }

                let isRed = redList.includes(winningNum);
                let popup = document.getElementById('cinematicResultPopup');
                document.getElementById('popupWinningNumDisplay').innerText = \`\${winningNum} (\${winningNum===0?'ZERO':(isRed?'RED':'BLACK')})\`;
                updateBalancesDisplay();

                if(popup) {
                    popup.style.display = 'flex';
                    setTimeout(() => { popup.style.display = 'none'; isGameSpinning = false; document.getElementById('lobbyStatusMsg').innerText = "Ready!"; }, 2500);
                } else { isGameSpinning = false; }
            }, 5000);
        }

        function drawCanvasWheel(canvasId, radiusSize, fontSize) {
            const canvas = document.getElementById(canvasId); if (!canvas) return;
            const ctx = canvas.getContext('2d'), cx = canvas.width / 2, cy = canvas.height / 2;
            const outerRadius = cx - 2, arcSize = (2 * Math.PI) / numbersList.length;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            numbersList.forEach((num, i) => {
                const angle = i * arcSize - Math.PI / 2;
                ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, outerRadius, angle, angle + arcSize);
                ctx.lineTo(cx, cy); ctx.fillStyle = num === 0 ? '#1b5e20' : (redList.includes(num) ? '#b03a2e' : '#0f171e');
                ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = '#ffd700'; ctx.stroke();
                ctx.save(); ctx.translate(cx, cy); ctx.rotate(angle + arcSize / 2);
                ctx.textAlign = 'right'; ctx.fillStyle = '#fff'; ctx.font = \`bold \${fontSize || 12}px Arial\`;
                ctx.fillText(num, outerRadius - 8, 3); ctx.restore();
            });
        }

        window.saveAdminSettings = function() {
            let sel = document.getElementById('adminRigSelect').value;
            rigRef.set(sel).then(() => {
                showCustomAlert("✅ Rig number saved: " + sel);
                document.getElementById('secretAdminModal').style.display = 'none';
            });
        };

        window.approveCloudDeposit = function(depKey, userPhone, amount) {
            usersRef.child(userPhone).once("value", (snap) => {
                let cur = (snap.val() && snap.val().balance) || 0;
                usersRef.child(userPhone + "/ledger").push({ amount: amount, sourceType: 'DEPOSIT_APPROVED', description: \`Approved Deposit ₹\${amount}\`, timestamp: Date.now() });
                usersRef.child(userPhone).update({ balance: cur + amount }).then(() => {
                    depositsRef.child(depKey).update({ status: 'Approved' });
                    showCustomAlert("Deposit approved!");
                });
            });
        };

        window.openDepositModal = function() { document.getElementById('depositModalBox').style.display = 'flex'; };
        window.openWithdrawModal = function() { document.getElementById('withdrawModalBox').style.display = 'flex'; };
        window.openTransferModal = function() { document.getElementById('transferModalBox').style.display = 'flex'; };
        window.closeWalletModals = function() { document.querySelectorAll('.wallet-modal').forEach(m => m.style.display = 'none'); };
        window.closeComingSoonModal = function() { document.getElementById('comingSoonNoticeModal').style.display = 'none'; playMasterAudio(); };
        window.logoutToLogin = function() { location.reload(); };
        window.requestStrictOtp = function() { document.getElementById('inputOtp').value = Math.floor(100000 + Math.random() * 900000); };
    </script>
</body>
</html>`;

app.get('/', (req, res) => {
    res.send(HTML_CONTENT);
});

server.listen(PORT, () => {
    console.log(`👑 Royal Roulette Direct-API Master Server running on port ${PORT}`);
});
