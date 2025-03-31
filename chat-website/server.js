require('dotenv').config();
const express = require('express');
const socketio = require('socket.io');
const http = require('http');
const path = require('path');
const bcrypt = require('bcrypt');
// Add markMessageAsSeen to imports
const { createUser, findUserByEmail, searchUsers, saveMessage, getMessages, getDB, markMessageAsSeen } = require('./models/User');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = socketio(server);

app.use(express.json());
app.use(express.static('public'));
app.use(express.static('views'));

// Root route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// Configure file uploads
const storage = multer.diskStorage({
    destination: 'public/uploads/',
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ 
    storage,
    limits: { fileSize: 100 * 1024 * 1024 }, // Increased to 100MB for larger videos
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/') || 
            file.mimetype.startsWith('video/') ||
            file.mimetype === 'application/pdf' ||
            file.mimetype === 'application/msword' ||
            file.originalname.match(/\.(mp4|webm|ogg|mov|avi|wmv|flv|mkv|3gp|m4v)$/i)) {
            cb(null, true);
        } else {
            cb(new Error('Unsupported file type'), false);
        }
    }
}).array('files');

// Auth routes
app.post('/api/signup', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        const userId = await createUser(username, email, password);
        res.json({ success: true, userId });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await findUserByEmail(email);
        if (!user || !(await bcrypt.compare(password, user.password))) {
            throw new Error('Invalid credentials');
        }
        res.json({ success: true, userId: user.id, username: user.username });
    } catch (error) {
        res.status(401).json({ error: error.message });
    }
});

// Chat routes
app.get('/api/messages', async (req, res) => {
    try {
        const { user1, user2 } = req.query;
        const messages = await getMessages(user1, user2);
        res.json(messages);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/users/search', async (req, res) => {
    try {
        const { q } = req.query;
        const users = await searchUsers(q);
        res.json(users);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update the recent chats endpoint
app.get('/api/chats/recent/:userId', async (req, res) => {
    try {
        const db = await getDB();
        const userId = req.params.userId;
        
        const messages = db.messages.filter(msg => 
            msg.from === userId || msg.to === userId
        );

        const chatPartners = {};
        messages.forEach(msg => {
            const partnerId = msg.from === userId ? msg.to : msg.from;
            const partner = db.users.find(u => u.id === partnerId);
            
            if (!chatPartners[partnerId]) {
                chatPartners[partnerId] = {
                    partnerId,
                    partnerName: partner ? partner.username : 'Unknown User',
                    lastMessage: msg.content,
                    timestamp: msg.timestamp,
                    unreadCount: 0
                };
            }

            // Update last message if newer
            if (new Date(chatPartners[partnerId].timestamp) < new Date(msg.timestamp)) {
                chatPartners[partnerId].lastMessage = msg.content;
                chatPartners[partnerId].timestamp = msg.timestamp;
            }

            // Count unread messages
            if (msg.to === userId && !msg.seen) {
                chatPartners[partnerId].unreadCount++;
            }
        });

        const recentChats = Object.values(chatPartners)
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        res.json(recentChats);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch recent chats' });
    }
});

app.post('/api/upload', (req, res) => {
    upload(req, res, function(err) {
        if (err) {
            return res.status(400).json({ error: err.message });
        }
        const files = req.files.map(file => ({
            filename: file.filename,
            path: `/uploads/${file.filename}`
        }));
        res.json(files);
    });
});

// Update Socket.IO connection handling
io.on('connection', (socket) => {
    let currentUserId = null;
    let currentRoom = null;

    socket.on('join', (userId) => {
        currentUserId = userId;
        socket.join(userId);
        socket.broadcast.emit('userOnline', userId);
    });

    socket.on('joinChat', (chatId) => {
        if (currentRoom) {
            socket.leave(currentRoom);
        }
        currentRoom = chatId;
        socket.join(chatId);
    });

    socket.on('sendMessage', async (message) => {
        try {
            const savedMessage = await saveMessage(message);
            io.to(message.to).emit('newMessage', savedMessage);
            io.to(message.from).emit('newMessage', savedMessage);
            
            if (io.sockets.adapter.rooms.has(message.to)) {
                await markMessageAsDelivered(savedMessage.id);
                io.to(message.from).emit('messageDelivered', savedMessage.id);
            }
        } catch (error) {
            console.error('Error saving message:', error);
        }
    });

    socket.on('markSeen', async ({ fromUserId, toUserId }) => {
        try {
            await markMessageAsSeen(fromUserId, toUserId);
            io.to(fromUserId).emit('messagesSeen', { fromUserId, toUserId });
            io.to(toUserId).emit('messagesSeen', { fromUserId, toUserId });
            
            io.to(fromUserId).emit('refreshChats');
            io.to(toUserId).emit('refreshChats');
        } catch (error) {
            console.error('Error marking messages as seen:', error);
        }
    });

    socket.on('disconnect', () => {
        if (currentUserId) {
            socket.broadcast.emit('userOffline', currentUserId);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// Add this new route for deleting messages
app.post('/api/messages/delete', async (req, res) => {
    try {
        const { messageIds } = req.body;
        const db = await getDB();
        
        // Filter out deleted messages
        db.messages = db.messages.filter(msg => !messageIds.includes(msg.id));
        
        await saveDB(db);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete messages' });
    }
});