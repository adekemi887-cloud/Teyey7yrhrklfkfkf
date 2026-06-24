const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sdk = require('node-appwrite');
const cors = require('cors');

const app = express();

// Enable CORS for Express routes (Allows your frontend to fetch the user list)
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

// Configure CORS for Socket.IO
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// --- APPWRITE CONFIGURATION ---
const APPWRITE_ENDPOINT = 'https://cloud.appwrite.io/v1';
const APPWRITE_PROJECT_ID = 'jerry';
// HARDCODED API KEY AS REQUESTED
const APPWRITE_API_KEY = 'standard_c64a2df428cef6ff1090c6236705f1c1fbf115c41f33d960b0ff64496a24f545b653a8b0550660f13fc9e8eccdb116a0e16e8bb506a10f61098234ff89b93889ce21324fd225b3c49f1822009674e260f6b35fcd369dedf77337e7ca9be586c4316557459631b49d0667ef69d8af6ff66b123316fb3b4a47e0ea8eabbba6c6a7';

// 1. Admin Client (Has full privileges using the API Key)
const adminClient = new sdk.Client()
    .setEndpoint(APPWRITE_ENDPOINT)
    .setProject(APPWRITE_PROJECT_ID)
    .setKey(APPWRITE_API_KEY);

const appwriteUsers = new sdk.Users(adminClient);

// Memory store for tracking connected users (Map<userId, socketId>)
const connectedUsers = new Map();

// --- EXPRESS ROUTE: FETCH USERS FOR FRONTEND SEARCH BAR ---
// The frontend will call this to populate the contact list and enable searching.
app.get('/api/users', async (req, res) => {
    try {
        // Use the Admin API Key to list all users registered in Appwrite
        const userList = await appwriteUsers.list();
        
        // Map the data into a clean array for the frontend
        const formattedUsers = userList.users.map(u => ({
            id: u.$id,
            username: u.name,
            email: u.email,
            // Generate standard avatar based on name
            avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(u.name)}&background=00a884&color=fff&bold=true`
        }));
        
        res.json(formattedUsers);
    } catch (error) {
        console.error("Error fetching users from Appwrite:", error.message);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});


// --- SOCKET.IO MIDDLEWARE (AUTHENTICATION) ---
io.use(async (socket, next) => {
    try {
        const token = socket.handshake.auth.token;
        if (!token) return next(new Error("Authentication error: No token provided"));
        
        // 2. User Client (Validates who the specific connecting user is via their JWT)
        const userClient = new sdk.Client()
            .setEndpoint(APPWRITE_ENDPOINT)
            .setProject(APPWRITE_PROJECT_ID)
            .setJWT(token);
        
        const account = new sdk.Account(userClient);
        
        // Fetch the user profile using the JWT. If successful, the token is valid.
        const user = await account.get();
        
        // Attach user info to the socket session
        socket.user = {
            id: user.$id,
            name: user.name,
            email: user.email
        };
        
        next();
    } catch (error) {
        console.error("Socket Auth Error:", error.message);
        next(new Error("Authentication error: Invalid or expired token"));
    }
});

// --- SOCKET.IO EVENT LISTENERS (REAL-TIME RELAY) ---
io.on('connection', (socket) => {
    const userId = socket.user.id;
    
    // Register user as online
    connectedUsers.set(userId, socket.id);
    console.log(`[ONLINE] ${socket.user.name} (${userId}) connected.`);
    
    // Broadcast to all users that this user is online
    io.emit('user_status', { userId, status: 'online' });
    
    // Handle Private Messaging Relay
    socket.on('send_message', (payload, callback) => {
        const { receiverId, text, mediaUrl, mediaType } = payload;
        const receiverSocketId = connectedUsers.get(receiverId);
        
        if (receiverSocketId) {
            // Receiver is online -> Relay the message
            const messageData = {
                id: Date.now().toString(),
                senderId: userId,
                senderName: socket.user.name,
                receiverId,
                text,
                mediaUrl,
                mediaType,
                ts: Date.now()
            };
            
            // Send strictly to the receiver
            io.to(receiverSocketId).emit('receive_message', messageData);
            
            // Acknowledge delivery to the sender
            if (callback) callback({ status: 'delivered', messageData });
        } else {
            // Receiver is offline -> Server drops message (Frontend Local storage handles history)
            if (callback) callback({ status: 'failed', error: 'User is offline. Message not delivered.' });
        }
    });
    
    // Handle Online Status Check
    socket.on('check_status', (targetUserId, callback) => {
        const isOnline = connectedUsers.has(targetUserId);
        if (callback) callback({ userId: targetUserId, status: isOnline ? 'online' : 'offline' });
    });
    
    // Handle Disconnect
    socket.on('disconnect', () => {
        connectedUsers.delete(userId);
        console.log(`[OFFLINE] ${socket.user.name} (${userId}) disconnected.`);
        io.emit('user_status', { userId, status: 'offline' });
    });
});

// Health check route for Render
app.get('/', (req, res) => {
    res.send('ChatPro Relay Server is running.');
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});