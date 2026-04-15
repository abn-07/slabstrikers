const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const MAINTENANCE_MODE = false;

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

const rooms = {};

// Helper: find which room a socket belongs to
function findRoom(socketId) {
    for (const r in rooms) {
        if (rooms[r].players[socketId]) return r;
    }
    return null;
}

// Reset ball to center with a random direction
function resetBall() {
    return {
        x: 400, y: 300,
        dx: 2 * (Math.random() > 0.5 ? 1 : -1),
        dy: 2 * (Math.random() > 0.5 ? 1 : -1),
        width: 15, height: 15
    };
}

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);

    if (MAINTENANCE_MODE) {
        socket.emit('maintenance');
        return;
    }

    socket.on('joinRoom', (roomName) => {
        // Validate room name
        if (!roomName || typeof roomName !== 'string' || roomName.trim() === '') {
            socket.emit('joinError', 'Please enter a valid room name.');
            return;
        }
        roomName = roomName.trim();

        // Cap room at 2 players
        if (rooms[roomName] && Object.keys(rooms[roomName].players).length >= 2) {
            socket.emit('joinError', 'Room is full (max 2 players).');
            return;
        }

        socket.join(roomName);

        if (!rooms[roomName]) {
            rooms[roomName] = {
                players: {},
                ball: resetBall(),
                scores: {},
                started: false
            };
        }

        const playerCount = Object.keys(rooms[roomName].players).length;
        // Player 1 gets bottom paddle, Player 2 gets top paddle
        const startY = playerCount === 0 ? 550 : 50;

        rooms[roomName].players[socket.id] = {
            x: 350,
            y: startY,
            width: 100,
            height: 20
        };
        rooms[roomName].scores[socket.id] = 0;

        // Start the game once 2 players have joined
        if (Object.keys(rooms[roomName].players).length === 2) {
            rooms[roomName].started = true;
            io.to(roomName).emit('gameStart');
        } else {
            socket.emit('waitingForPlayer');
        }

        socket.emit('joinSuccess', roomName);
    });

    socket.on('playerInput', (direction) => {
        const roomName = findRoom(socket.id);
        if (!roomName) return;

        const room = rooms[roomName];
        if (!room.started) return;

        const player = room.players[socket.id];
        const speed = 10;
        if (direction === 'left') player.x -= speed;
        if (direction === 'right') player.x += speed;

        // Clamp paddle within canvas bounds
        if (player.x < 0) player.x = 0;
        if (player.x > 800 - player.width) player.x = 800 - player.width;
    });

    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        const roomName = findRoom(socket.id);
        if (!roomName) return;

        // Remove the player from the room
        delete rooms[roomName].players[socket.id];
        delete rooms[roomName].scores[socket.id];

        // Notify remaining players
        io.to(roomName).emit('playerLeft');

        // Clean up empty rooms
        if (Object.keys(rooms[roomName].players).length === 0) {
            delete rooms[roomName];
            console.log(`Room "${roomName}" deleted (empty).`);
        } else {
            // Reset game state so the remaining player waits for a new opponent
            rooms[roomName].started = false;
            rooms[roomName].ball = resetBall();
            io.to(roomName).emit('waitingForPlayer');
        }
    });
});

setInterval(() => {
    for (const roomName in rooms) {
        const room = rooms[roomName];

        // Don't move ball until game has started (2 players present)
        if (!room.started) continue;

        const ball = room.ball;

        ball.x += ball.dx;
        ball.y += ball.dy;

        // Side wall bounce
        if (ball.x <= 0) {
            ball.x = 0;
            ball.dx *= -1;
        } else if (ball.x + ball.width >= 800) {
            ball.x = 800 - ball.width;
            ball.dx *= -1;
        }

        // Paddle collision
        for (let id in room.players) {
            const p = room.players[id];
            if (
                ball.x < p.x + p.width &&
                ball.x + ball.width > p.x &&
                ball.y < p.y + p.height &&
                ball.y + ball.height > p.y
            ) {
                // 1. Reverse the Y direction
                ball.dy *= -1;

                // 2. Snap the ball perfectly outside the paddle so it can't get stuck
                if (p.y > 300) {
                    // Hit the bottom paddle -> snap ball to the top edge of it
                    ball.y = p.y - ball.height;
                } else {
                    // Hit the top paddle -> snap ball to the bottom edge of it
                    ball.y = p.y + p.height;
                }

                // 3. Apply the speed multiplier
                const maxSpeed = 6; 
                ball.dx *= 1.02;
                ball.dy *= 1.02;
                if (Math.abs(ball.dx) > maxSpeed) ball.dx = maxSpeed * Math.sign(ball.dx);
                if (Math.abs(ball.dy) > maxSpeed) ball.dy = maxSpeed * Math.sign(ball.dy);

                // 4. Shrink the paddle
                if (p.width > 40) p.width -= 1;
            }
        }

        // Ball out of bounds — award a point and check for win
        if (ball.y <= 0 || ball.y + ball.height >= 600) {
            let winnerId = null;

            for (let id in room.players) {
                const p = room.players[id];
                if (ball.y <= 0 && p.y > 300) {
                    room.scores[id]++;
                    if (room.scores[id] >= 10) winnerId = id;
                }
                if (ball.y + ball.height >= 600 && p.y < 300) {
                    room.scores[id]++;
                    if (room.scores[id] >= 10) winnerId = id;
                }
            }

            // FEATURE: 10-Point Win Condition
            if (winnerId) {
                io.to(roomName).emit('gameOver', winnerId);
                
                // Reset the room for a new game
                room.started = false;
                room.ball = resetBall();
                for (let id in room.players) {
                    room.scores[id] = 0;
                    room.players[id].width = 100;
                }
                
                // Wait a few seconds, then restart the lobby
                setTimeout(() => {
                    if (rooms[roomName]) {
                        io.to(roomName).emit('waitingForPlayer');
                    }
                }, 4000);

            } else {
                // Normal reset for the next round
                room.ball = resetBall();
                for (let id in room.players) {
                    room.players[id].width = 100;
                }
            }
        }

        io.to(roomName).emit('updateState', {
            players: room.players,
            ball: room.ball,
            scores: room.scores
        });
    }
}, 16);

// Fix: package.json "main" points to index.js — rename this file to index.js
// OR update package.json "main" to "server.js" and add a start script.
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});