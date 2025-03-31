const fs = require('fs').promises;
const path = require('path');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = path.join(__dirname, '../data/db.json');

// Initialize database if it doesn't exist
async function initDB() {
    try {
        await fs.access(DB_PATH);
    } catch {
        const defaultDB = {
            users: [],
            messages: []
        };
        await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
        await fs.writeFile(DB_PATH, JSON.stringify(defaultDB, null, 2));
    }
}

async function getDB() {
    await initDB();
    const data = await fs.readFile(DB_PATH, 'utf8');
    return JSON.parse(data);
}

async function saveDB(db) {
    await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2));
}

async function createUser(username, email, password) {
    const db = await getDB();
    
    if (db.users.some(u => u.email === email)) {
        throw new Error('Email already exists');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = {
        id: uuidv4(),
        username,
        email,
        password: hashedPassword
    };

    db.users.push(newUser);
    await saveDB(db);
    return newUser.id;
}

async function findUserByEmail(email) {
    const db = await getDB();
    return db.users.find(u => u.email === email);
}

async function searchUsers(query) {
    const db = await getDB();
    if (!query) {
        // Return empty array when no query
        return [];
    }
    
    const lowercaseQuery = query.toLowerCase();
    return db.users.filter(user => 
        user.username.toLowerCase().includes(lowercaseQuery) ||
        user.email.toLowerCase().includes(lowercaseQuery)
    ).map(({ id, username, email }) => ({ id, username, email }));
}

async function saveMessage(message) {
    const db = await getDB();
    const newMessage = {
        ...message,
        id: uuidv4(),
        delivered: false,
        seen: false
    };
    db.messages.push(newMessage);
    await saveDB(db);
    return newMessage;
}

async function markMessageAsDelivered(messageId) {
    const db = await getDB();
    let updated = false;
    db.messages = db.messages.map(msg => {
        if (msg.id === messageId && !msg.delivered) {
            updated = true;
            return { ...msg, delivered: true };
        }
        return msg;
    });
    if (updated) {
        await saveDB(db);
    }
}

async function markMessageAsSeen(fromUserId, toUserId) {
    const db = await getDB();
    let updated = false;
    db.messages = db.messages.map(msg => {
        if (msg.from === fromUserId && msg.to === toUserId && !msg.seen) {
            updated = true;
            return { ...msg, seen: true };
        }
        return msg;
    });
    if (updated) {
        await saveDB(db);
    }
}

async function getMessages(user1, user2) {
    const db = await getDB();
    return db.messages.filter(msg => 
        (msg.from === user1 && msg.to === user2) ||
        (msg.from === user2 && msg.to === user1)
    ).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

// Update the exports section
module.exports = {
    getDB,
    createUser,
    findUserByEmail,
    searchUsers,
    saveMessage,
    getMessages,
    markMessageAsDelivered,  // Add this
    markMessageAsSeen
};