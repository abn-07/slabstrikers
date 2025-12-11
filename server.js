const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

const rooms = {};

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);

    socket.on('joinRoom', (roomName) => {
        socket.join(roomName);

        if (!rooms[roomName]) {
            rooms[roomName] = { 
                players: {},
                ball: { 
                    x: 400, y: 300, 
                    dx: 2, dy: 2, // Base Speed
                    width: 15, height: 15 
                } 
            };
        }

        const playerCount = Object.keys(rooms[roomName].players).length;
        let startY = 550; 
        if (playerCount === 1) startY = 50; 
        if (playerCount === 2) startY = 300; 

        rooms[roomName].players[socket.id] = { 
            x: 350, 
            y: startY, 
            width: 100, // Base Width
            height: 20 
        };
    });

    socket.on('playerInput', (direction) => {
        let roomName = null;
        for (const r in rooms) {
            if (rooms[r].players[socket.id]) {
                roomName = r;
                break;
            }
        }

        if (roomName) {
            const player = rooms[roomName].players[socket.id];
            if (direction === 'left') player.x -= 10;
            if (direction === 'right') player.x += 10;
            if (player.x < 0) player.x = 0;
            if (player.x > 700) player.x = 700;
        }
    });

    socket.on('disconnect', () => {
        console.log('Player disconnected');
    });
});

// THE GAME LOOP (60 FPS)
setInterval(() => {
    for (const roomName in rooms) {
        const room = rooms[roomName];
        
        if (room.ball) {
            // 1. Move Ball
            room.ball.x += room.ball.dx;
            room.ball.y += room.ball.dy;

            // 2. Wall Bouncing
            if (room.ball.x <= 0 || room.ball.x >= 785) {
                room.ball.dx *= -1;
            }

            // 3. Paddle Collision (Modified for Difficulty)
            for (let id in room.players) {
                const p = room.players[id];
                
                if (
                    room.ball.x < p.x + p.width &&
                    room.ball.x + room.ball.width > p.x &&
                    room.ball.y < p.y + p.height &&
                    room.ball.y + room.ball.height > p.y
                ) {
                    // Reverse Direction
                    room.ball.dy *= -1;
                    room.ball.y += room.ball.dy * 2; 

                    // *** DIFFICULTY INCREASE ***
                    // 1. Increase Speed by 5%
                    room.ball.dx *= 1.05;
                    room.ball.dy *= 1.05;

                    // 2. Shrink Paddle by 5px (Don't go below 40px)
                    if (p.width > 40) {
                        p.width -= 5;
                    }
                }
            }

            // 4. Reset on Goal (Modified to Reset Stats)
            if (room.ball.y <= 0 || room.ball.y >= 600) {
                // Reset Position
                room.ball.x = 400;
                room.ball.y = 300;
                
                // Reset Speed
                room.ball.dx = 2;
                room.ball.dy = 2; // Keep direction positive/negative randomized later if you want
                if (Math.random() > 0.5) room.ball.dy *= -1; // Randomize start direction

                // Reset Paddle Sizes
                for (let id in room.players) {
                    room.players[id].width = 100;
                }
            }
        }
        io.to(roomName).emit('updateState', room);
    }
}, 16); 

server.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});