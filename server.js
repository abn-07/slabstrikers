const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const MAINTENANCE_MODE = false;
const DATA_FILE = path.join(__dirname, 'users.json');

// ── Persistence ───────────────────────────────────────────────────
function loadUsers() {
    try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
    catch (e) { console.error('Load error:', e); }
    return {};
}
function saveUsers() {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2)); }
    catch (e) { console.error('Save error:', e); }
}
let users = loadUsers();
// users[lowerKey] = { displayName, passwordHash, wins, gamesPlayed }

function hashPass(p) {
    return crypto.createHash('sha256').update(p + 'ss_salt_9x').digest('hex');
}

// ── Rooms ─────────────────────────────────────────────────────────
const rooms = {};

function genCode() {
    const C = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do { code = Array.from({ length: 6 }, () => C[Math.floor(Math.random() * C.length)]).join(''); }
    while (rooms[code]);
    return code;
}

function resetBall() {
    return { x: 392, y: 292, dx: 3 * (Math.random() > 0.5 ? 1 : -1), dy: 3 * (Math.random() > 0.5 ? 1 : -1), width: 16, height: 16 };
}

function resetPositions(room) {
    const ids = Object.keys(room.players);
    if (ids.length === 0) return;
    room.players[ids[0]].x = 350; room.players[ids[0]].y = 550; room.players[ids[0]].width = 100;
    if (ids[1]) { room.players[ids[1]].x = 350; room.players[ids[1]].y = 50; room.players[ids[1]].width = 100; }
}

// ── Bot AI ────────────────────────────────────────────────────────
function updateBot(room) {
    const bot = room.players['__bot__'];
    if (!bot) return;
    const ball = room.ball;
    // Only chase when ball moving toward bot (bot is at top, y=50)
    if (ball.dy > 0 && ball.y > 250) return;
    const target = ball.x + ball.width / 2 - bot.width / 2;
    const diff = target - bot.x;
    const jitter = (Math.random() - 0.5) * 4;
    bot.x += Math.min(Math.abs(diff), 5) * Math.sign(diff) + jitter;
    bot.x = Math.max(0, Math.min(800 - bot.width, bot.x));
}

// ── Helpers ───────────────────────────────────────────────────────
function leaveCurrentRoom(socket) {
    const code = socket.currentRoom;
    if (!code || !rooms[code]) return;
    socket.leave(code);
    delete rooms[code].players[socket.id];
    delete rooms[code].scores[socket.id];
    if (Object.keys(rooms[code].players).filter(k => k !== '__bot__').length === 0) {
        delete rooms[code];
    } else {
        rooms[code].started = false;
        rooms[code].ball = resetBall();
        io.to(code).emit('playerLeft');
    }
    socket.currentRoom = null;
}

// ── Socket ────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log('Connected:', socket.id);
    if (MAINTENANCE_MODE) { socket.emit('maintenance'); return; }

    // AUTH
    socket.on('register', ({ username, password }) => {
        if (!username || !password) return socket.emit('authError', 'Fill all fields.');
        username = username.trim();
        if (!/^[a-zA-Z0-9_]{3,16}$/.test(username)) return socket.emit('authError', 'Username: 3-16 chars, letters/numbers/underscore only.');
        if (password.length < 4) return socket.emit('authError', 'Password must be at least 4 characters.');
        const key = username.toLowerCase();
        if (users[key]) return socket.emit('authError', 'Username already taken.');
        users[key] = { displayName: username, passwordHash: hashPass(password), wins: 0, gamesPlayed: 0 };
        saveUsers();
        socket.username = key; socket.displayName = username;
        socket.emit('authSuccess', { username, wins: 0, gamesPlayed: 0 });
    });

    socket.on('login', ({ username, password }) => {
        if (!username || !password) return socket.emit('authError', 'Fill all fields.');
        const key = username.trim().toLowerCase();
        const u = users[key];
        if (!u || u.passwordHash !== hashPass(password)) return socket.emit('authError', 'Invalid username or password.');
        socket.username = key; socket.displayName = u.displayName;
        socket.emit('authSuccess', { username: u.displayName, wins: u.wins, gamesPlayed: u.gamesPlayed });
    });

    socket.on('getLeaderboard', () => {
        const lb = Object.values(users)
            .sort((a, b) => b.wins - a.wins || b.gamesPlayed - a.gamesPlayed)
            .slice(0, 10)
            .map((u, i) => ({
                rank: i + 1, username: u.displayName, wins: u.wins,
                gamesPlayed: u.gamesPlayed,
                winRate: u.gamesPlayed > 0 ? Math.round((u.wins / u.gamesPlayed) * 100) : 0
            }));
        socket.emit('leaderboard', lb);
    });

    // CREATE ROOM (auto-generate code)
    socket.on('createRoom', () => {
        if (!socket.username) return socket.emit('roomError', 'Login first.');
        leaveCurrentRoom(socket);
        const code = genCode();
        rooms[code] = { players: {}, ball: resetBall(), scores: {}, started: false, isBot: false, host: socket.id };
        socket.join(code);
        rooms[code].players[socket.id] = { x: 350, y: 550, width: 100, height: 20, displayName: socket.displayName, isBot: false };
        rooms[code].scores[socket.id] = 0;
        socket.currentRoom = code;
        socket.emit('roomCreated', { code });
        socket.emit('waitingForPlayer');
    });

    // JOIN BY CODE
    socket.on('joinRoomByCode', (code) => {
        if (!socket.username) return socket.emit('joinError', 'Login first.');
        if (!code) return socket.emit('joinError', 'Enter a room code.');
        code = code.trim().toUpperCase();
        const room = rooms[code];
        if (!room) return socket.emit('joinError', 'Room not found. Check the code.');
        if (room.isBot) return socket.emit('joinError', 'That is a bot game room.');
        if (Object.keys(room.players).length >= 2) return socket.emit('joinError', 'Room is full (2/2).');
        leaveCurrentRoom(socket);
        socket.join(code);
        const existing = Object.values(room.players);
        const startY = existing.length > 0 && existing[0].y > 300 ? 50 : 550;
        room.players[socket.id] = { x: 350, y: startY, width: 100, height: 20, displayName: socket.displayName, isBot: false };
        room.scores[socket.id] = 0;
        socket.currentRoom = code;
        room.started = true;
        socket.emit('joinedRoom', { code });
        io.to(code).emit('gameStart');
    });

    // PLAY VS BOT
    socket.on('playVsBot', () => {
        if (!socket.username) return socket.emit('roomError', 'Login first.');
        leaveCurrentRoom(socket);
        const code = genCode();
        rooms[code] = { players: {}, ball: resetBall(), scores: {}, started: true, isBot: true, host: socket.id };
        socket.join(code);
        rooms[code].players[socket.id] = { x: 350, y: 550, width: 100, height: 20, displayName: socket.displayName, isBot: false };
        rooms[code].players['__bot__'] = { x: 350, y: 50, width: 100, height: 20, displayName: '🤖 BOT', isBot: true };
        rooms[code].scores[socket.id] = 0;
        rooms[code].scores['__bot__'] = 0;
        socket.currentRoom = code;
        socket.emit('botGameStart');
        socket.emit('gameStart');
    });

    // INPUT
    socket.on('playerInput', (dir) => {
        const code = socket.currentRoom;
        if (!code || !rooms[code] || !rooms[code].started) return;
        const p = rooms[code].players[socket.id];
        if (!p) return;
        if (dir === 'left') p.x -= 10;
        if (dir === 'right') p.x += 10;
        p.x = Math.max(0, Math.min(800 - p.width, p.x));
    });

    // LEAVE GAME
    socket.on('leaveGame', () => leaveCurrentRoom(socket));

    // DISCONNECT
    socket.on('disconnect', () => {
        console.log('Disconnected:', socket.id);
        leaveCurrentRoom(socket);
    });
});

// ── Game Loop ─────────────────────────────────────────────────────
setInterval(() => {
    for (const code in rooms) {
        const room = rooms[code];
        if (!room.started) continue;

        if (room.isBot) updateBot(room);

        const ball = room.ball;
        ball.x += ball.dx; ball.y += ball.dy;

        // Wall bounce
        if (ball.x <= 0) { ball.x = 0; ball.dx *= -1; }
        else if (ball.x + ball.width >= 800) { ball.x = 800 - ball.width; ball.dx *= -1; }

        // Paddle collision
        for (const id in room.players) {
            const p = room.players[id];
            if (ball.x < p.x + p.width && ball.x + ball.width > p.x && ball.y < p.y + p.height && ball.y + ball.height > p.y) {
                ball.dy *= -1;
                ball.y = p.y > 300 ? p.y - ball.height : p.y + p.height;
                const maxSpeed = 7;
                ball.dx = Math.sign(ball.dx) * Math.min(Math.abs(ball.dx) * 1.03, maxSpeed);
                ball.dy = Math.sign(ball.dy) * Math.min(Math.abs(ball.dy) * 1.03, maxSpeed);
                if (p.width > 40) p.width -= 1;
            }
        }

        // Out of bounds
        if (ball.y <= 0 || ball.y + ball.height >= 600) {
            let winnerId = null;
            for (const id in room.players) {
                const p = room.players[id];
                if (ball.y <= 0 && p.y > 300) { room.scores[id]++; if (room.scores[id] >= 10) winnerId = id; }
                if (ball.y + ball.height >= 600 && p.y < 300) { room.scores[id]++; if (room.scores[id] >= 10) winnerId = id; }
            }

            if (winnerId) {
                io.to(code).emit('gameOver', {
                    winnerId,
                    winnerName: room.players[winnerId]?.displayName || 'Unknown',
                    isBot: room.isBot
                });

                // Update stats for human players
                if (!room.isBot) {
                    for (const id in room.players) {
                        const s = io.sockets.sockets.get(id);
                        if (s && s.username && users[s.username]) {
                            users[s.username].gamesPlayed++;
                            if (id === winnerId) users[s.username].wins++;
                            saveUsers();
                        }
                    }
                } else {
                    // Bot game - only human player
                    const humanId = Object.keys(room.players).find(k => k !== '__bot__');
                    const s = humanId ? io.sockets.sockets.get(humanId) : null;
                    if (s && s.username && users[s.username]) {
                        users[s.username].gamesPlayed++;
                        if (humanId === winnerId) users[s.username].wins++;
                        saveUsers();
                    }
                }

                room.started = false;
                room.ball = resetBall();
                resetPositions(room);
                for (const id in room.scores) room.scores[id] = 0;

                setTimeout(() => {
                    if (!rooms[code]) return;
                    const humanCount = Object.keys(rooms[code].players).filter(k => k !== '__bot__').length;
                    if (room.isBot && humanCount > 0) {
                        rooms[code].started = true;
                        io.to(code).emit('gameRestart');
                    } else if (!room.isBot && humanCount === 2) {
                        rooms[code].started = true;
                        io.to(code).emit('gameRestart');
                    } else if (!room.isBot && humanCount === 1) {
                        io.to(code).emit('waitingForPlayer');
                    }
                }, 4000);
            } else {
                room.ball = resetBall();
                resetPositions(room);
            }
        }

        io.to(code).emit('updateState', { players: room.players, ball: room.ball, scores: room.scores, myId: null });
    }
}, 16);

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));