const firebaseConfig = {
    apiKey: "AIzaSyCifZeAzMLHBij4sBZYg8uLW2FnwKKDQ",
    authDomain: "royal-dijital.firebaseapp.com",
    databaseURL: "https://royal-dijital-default-rtdb.firebaseio.com",
    projectId: "royal-dijital",
    storageBucket: "royal-dijital.appspot.com",
    messagingSenderId: "440010959117",
    appId: "1:440010959117:web:12cc701a9bafa37727e844",
    measurementId: "G-7WKF885TDL"
};

try { if (!firebase.apps.length) firebase.initializeApp(firebaseConfig); } catch(e) {}

const socket = io({
    transports: ['polling', 'websocket'],
    reconnection: true
});

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
let activeRoundId = Math.floor(Date.now() / 1000 / 120);
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
            html += `<div style="background:#000; padding:4px; border-radius:3px; margin-bottom:2px; font-size:9px;">
                <b>${t.phone}</b>: "${t.message}"
                <button onclick="supportTicketsRef.child('${k}').update({status:'Resolved'})" style="background:#27ae60; color:#fff; border:none; padding:2px 4px; margin-left:4px; border-radius:2px; cursor:pointer;">Resolve</button>
            </div>`;
        }
    });
    listEl.innerHTML = html || "No tickets.";
});

livePlayersRef.on("value", (snap) => {
    let players = snap.val() || {}, listEl = document.getElementById('adminLiveOnlinePlayersList'), html = "", now = Date.now();
    if (!listEl) return;
    Object.values(players).forEach(p => {
        if (now - p.lastSeen < 4000) {
            html += `<div style="font-size:9px; color:#2ecc71;">📱 ${p.phone} (${p.vipId}) - ₹${p.balance}</div>`;
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
            html += `<div class="req-table-row"><span>${d.phone} - ₹${d.amount} (UTR: ${d.utr})</span>
            <div><button style="background:#27ae60; color:#fff; padding:3px 6px; border:none; border-radius:3px; font-weight:bold; cursor:pointer;" onclick="approveCloudDeposit('${key}', '${d.phone}', ${d.amount})">Approve</button></div></div>`;
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
            html += `<div class="req-table-row"><span>${w.phone} - ₹${w.amount}</span>
            <div><button style="background:#27ae60; color:#fff; padding:3px 6px; border:none; border-radius:3px; font-weight:bold; cursor:pointer;" onclick="withdrawsRef.child('${key}').update({status:'Approved'})">Pay</button></div></div>`;
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
    setupGlobalRoundBetsListener(activeRoundId, phone);
}

function setupGlobalRoundBetsListener(roundId, phone) {
    if (!roundId || !loggedUserPhone) return;
    masterRoot.child("live_rounds/" + roundId + "/bets/" + loggedUserPhone).on("value", (snapshot) => {
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
            html += `<div style="font-size:8.5px; border-bottom:1px dashed #333; padding:2px 0;"><b>${item.description || item.sourceType}</b>: <span style="color:${col};">${item.amount > 0 ? '+' : ''}₹${item.amount}</span></div>`;
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
            socket.emit('authenticate_socket', { phone: phone });
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

window.placeTableBet = function(key, el) {
    if (isGameSpinning) return;
    
    if (activeGameMode === 'real') { 
        if (realCoins < currentActiveChip) { showCustomAlert("Low Balance!"); return; } 
        
        socket.emit('place_secure_bet', { key: key, amount: currentActiveChip, roundId: activeRoundId });
        socket.once('bet_response', (resp) => {
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
        });
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
            socket.emit('place_secure_bet', { key: num.toString(), amount: currentActiveChip, roundId: activeRoundId });
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
        showCustomAlert("Last test bet cleared!");
    } else {
        showCustomAlert("Real bets are managed live on secure server.");
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
    document.getElementById('lobbyTimerMain').innerText = `${m<10?'0':''}${m}:${s<10?'0':''}${s}`;
    renderHistoryBarUI();
});

function renderHistoryBarUI() {
    let html = "";
    if (window.globalState.historyList) {
        window.globalState.historyList.forEach(num => {
            let cls = num === 0 ? 'green' : (redList.includes(num) ? 'red' : 'black');
            html += `<div class="history-ball ${cls}">${num}</div>`;
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
    if(ballOrbitEl) ballOrbitEl.style.transform = `rotate(${accumulatedBallRotation}deg)`;

    setTimeout(() => {
        if (ballRollAudio) ballRollAudio.pause();
        let ballDropAudio = document.getElementById('ballDropSfx');
        if (ballDropAudio) { ballDropAudio.currentTime = 0; ballDropAudio.play().catch(e => {}); }

        let isRed = redList.includes(winningNum);
        let popup = document.getElementById('cinematicResultPopup');
        document.getElementById('popupWinningNumDisplay').innerText = `${winningNum} (${winningNum===0?'ZERO':(isRed?'RED':'BLACK')})`;
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
        ctx.textAlign = 'right'; ctx.fillStyle = '#fff'; ctx.font = `bold ${fontSize || 12}px Arial`;
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
        usersRef.child(userPhone + "/ledger").push({ amount: amount, sourceType: 'DEPOSIT_APPROVED', description: `Approved Deposit ₹${amount}`, timestamp: Date.now() });
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
