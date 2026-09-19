const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

let globalGameState = {
    currentWinner: 14,
    historyList: [24, 14, 5, 22, 10, 3],
    adminRig: "random",
    adminQrUrl: "https://i.ibb.co/3yk54L2/1000532596.jpg",
    roundId: 1,
    timeLeft: 120
};

setInterval(() => {
    globalGameState.timeLeft--;
    if (globalGameState.timeLeft <= 0) {
        globalGameState.timeLeft = 120;
        globalGameState.roundId++;
        if (globalGameState.adminRig !== "random") {
            globalGameState.currentWinner = parseInt(globalGameState.adminRig);
        } else {
            const numbersList = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
            globalGameState.currentWinner = numbersList[Math.floor(Math.random() * numbersList.length)];
        }
        globalGameState.historyList.unshift(globalGameState.currentWinner);
        if (globalGameState.historyList.length > 6) globalGameState.historyList.pop();
    }
    io.emit('sync_game_state', globalGameState);
}, 1000);

io.on('connection', (socket) => {
    socket.emit('sync_game_state', globalGameState);
    socket.on('admin_update_command', (newData) => {
        if (newData.adminRig !== undefined) globalGameState.adminRig = newData.adminRig;
        if (newData.adminQrUrl !== undefined) globalGameState.adminQrUrl = newData.adminQrUrl;
        io.emit('sync_game_state', globalGameState);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
