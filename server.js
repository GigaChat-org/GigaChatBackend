require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require("mongoose");
const User = require('./models/User');
const Post = require('./models/Post');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const storage = multer.memoryStorage();
const uploadMiddleware = multer({ storage });
const fs = require('fs');
const salt = bcrypt.genSaltSync(10);
const secret = process.env.JWT_SECRET;
const cloudinary = require('cloudinary').v2;


const app = express();
const PORT = 3000;

app.use(cors({ credentials: true, origin: 'http://localhost:5173' }));
app.use(express.json());
app.use(cookieParser());


const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: 'http://localhost:5173',
    methods: ['GET', 'POST'],
  },
});


cloudinary.config({ 
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.CLOUD_API_KEY,
  api_secret: process.env.CLOUD_API_SEC
});

mongoose.connect(
  process.env.MONGO_URL,
  { useNewUrlParser: true, useUnifiedTopology: true }
).then(() => {
  console.log("Connected to MongoDB!");
}).catch((err) => {
  console.error("MongoDB connection error:", err);
});

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
``
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

app.post('/register', async (req,res) => {
  const {username,password} = req.body;
  try{
    const userDoc = await User.create({
      username,
      password:bcrypt.hashSync(password,salt),
    });
    res.json(userDoc);
  } catch(e) {
    console.log(e);
    res.status(400).json(e);
  }
});

app.post('/login-admin', async (req,res) => {
  const {username,password} = req.body;
  const userDoc = await User.findOne({username});
  if (!userDoc) {
    return res.status(400).json({ message: 'User not found' });
  }
  const passOk = bcrypt.compareSync(password, userDoc.password);
  if (passOk) {
    // logged in
    jwt.sign({username,id:userDoc._id, isAdmin: userDoc.isAdmin}, secret, {}, (err,token) => {
      if (err) throw err;
      res.cookie('token', token).json({
        id:userDoc._id,
        username,
        isAdmin: userDoc.isAdmin,
        token,
      });
    });
  } else {
    res.status(400).json('wrong credentials');
  }
});

app.get('/profile', (req,res) => {
  const {token} = req.cookies;
  if (!token) {
    return;
  }
  jwt.verify(token, secret, {}, (err,info) => {
    if (err) throw err;
    res.json(info);
  });
});

app.post('/logout', (req,res) => {
  res.cookie('token', '').json('ok');
});

app.post('/post', uploadMiddleware.single('file'), async (req, res) => {
  const { token } = req.cookies;

  jwt.verify(token, secret, {}, async (err, info) => {
    if (err) throw err;

    const { title, summary, content } = req.body;

    if (req.file) {
      const uploadResult = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          { folder: 'blog_images' },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        uploadStream.end(req.file.buffer);
      });

      const postDoc = await Post.create({
        title,
        summary,
        content,
        cover: uploadResult.secure_url,
        author: info.id,
      });

      res.json(postDoc);
    } else {
      res.status(400).json('No file uploaded');
    }
  });
});


app.put('/post', uploadMiddleware.single('file'), async (req, res) => {
  const { token } = req.cookies;

  jwt.verify(token, secret, {}, async (err, info) => {
    if (err) throw err;

    const { id, title, summary, content } = req.body;
    const postDoc = await Post.findById(id);

    const isAuthor = JSON.stringify(postDoc.author) === JSON.stringify(info.id);
    if (!isAuthor) {
      return res.status(400).json('You are not the author');
    }
    let newCoverUrl = postDoc.cover;

    if (req.file) {
      const uploadResult = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          { folder: 'blog_images' },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        uploadStream.end(req.file.buffer);
      });

      newCoverUrl = uploadResult.secure_url;
    }

    await postDoc.updateOne({
      title,
      summary,
      content,
      cover: newCoverUrl,
    });

    res.json(postDoc);
  });
});


app.get('/post', async (req,res) => {
  res.json(
    await Post.find()
      .populate('author', ['username'])
      .sort({createdAt: -1})
      .limit(20)
  );
});

app.get('/post/:id', async (req, res) => {
  const {id} = req.params;
  const postDoc = await Post.findById(id).populate('author', ['username']);
  res.json(postDoc);
})

server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
