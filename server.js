const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const PORT = 3000;

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: 'http://localhost:5173',
    methods: ['GET', 'POST'],
  },
});

app.use(cors({ origin: 'http://localhost:5173' }));
app.use(express.json());

let onlineUsers = []; // Track all connected users
let readyUsers = [];  // Track users who pressed "Start Chat"
let waitingUsers = []; // Track users who are waiting for a match
let matches = {};     // Track active matches

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);
  onlineUsers.push(socket.id);

  // Handle start-chat event
  socket.on('start-chat', () => {
    if (readyUsers.includes(socket.id) || matches[socket.id]) return;

    readyUsers.push(socket.id);
    matchUsers();
  });

  // Handle disconnect button press
  socket.on('disconnect-chat', () => {
    console.log(`User disconnected from chat: ${socket.id}`);

    readyUsers = readyUsers.filter((id) => id !== socket.id);

    const currentMatch = matches[socket.id];
    if (currentMatch) {
      io.to(currentMatch).emit('disconnected', 'Your match left.');
      delete matches[currentMatch];
    }

    delete matches[socket.id];
  });

  // Handle message event
  socket.on('message', (data) => {
    const recipient = matches[socket.id];
    if (recipient) {
      io.to(recipient).emit('message', { from: socket.id, text: data.text });
    }
  });

  // Handle next-match event
  socket.on('next-match', () => {
    const currentMatch = matches[socket.id];
    if (currentMatch) {
      // Notify the current match
      io.to(currentMatch).emit('disconnected', 'Your match left.');
      delete matches[currentMatch];
    }

    delete matches[socket.id];

    // First try to match with a waiting user (new user who pressed start-chat)
    if (waitingUsers.length > 0) {
      const waitingUser = waitingUsers.shift();
      matches[socket.id] = waitingUser;
      matches[waitingUser] = socket.id;

      io.to(socket.id).emit('matched', { with: waitingUser });
      io.to(waitingUser).emit('matched', { with: socket.id });

      // Remove waiting user from the waiting list since they are matched now
    } else {
      // If no user is waiting, add this user to the waiting queue
      waitingUsers.push(socket.id);
      io.to(socket.id).emit('waiting', 'Waiting for a new user...');
    }

    // Try matching ready users (new users who pressed "Start Chat")
    matchUsers();
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);

    onlineUsers = onlineUsers.filter((id) => id !== socket.id);
    readyUsers = readyUsers.filter((id) => id !== socket.id);
    waitingUsers = waitingUsers.filter((id) => id !== socket.id);

    const currentMatch = matches[socket.id];
    if (currentMatch) {
      io.to(currentMatch).emit('disconnected', 'Your match left.');
      delete matches[currentMatch];
    }

    delete matches[socket.id];
  });

  // Match users function
  function matchUsers() {
    while (readyUsers.length >= 2 || (readyUsers.length >= 1 && waitingUsers.length >= 1)) {
      let user1, user2;

      if (readyUsers.length >= 2) {
        user1 = readyUsers.shift();
        user2 = readyUsers.shift();
      } else {
        user1 = readyUsers.shift();
        user2 = waitingUsers.shift();
      }

      matches[user1] = user2;
      matches[user2] = user1;

      io.to(user1).emit('matched', { with: user2 });
      io.to(user2).emit('matched', { with: user1 });
    }
  }
});

server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
