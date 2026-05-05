require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const SockJS = require('sockjs');
const Stomp = require('stompjs');
const { v4: uuidv4 } = require('uuid');
const GameEngine = require('./game-engine');
const Database = require('./database');

// Initialize
const app = express();
const server = http.createServer(app);
const gameEngine = new GameEngine();
const db = new Database();

// ========== FIXED CORS MIDDLEWARE ==========
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'User-Id', 'X-Requested-With'],
    credentials: true
}));

// Handle preflight requests
app.options('*', cors());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Add request logging
app.use((req, res, next) => {
    console.log(`${req.method} ${req.url}`);
    next();
});

// Store active STOMP connections with health check
let connections = new Map();

// SockJS/STOMP setup
const sockjsServer = SockJS.createServer({
    sockjs_url: 'https://cdn.jsdelivr.net/npm/sockjs-client@1/dist/sockjs.min.js'
});

// STOMP over SockJS - FIXED
sockjsServer.on('connection', (conn) => {
    console.log('New WebSocket connection to Logo Bingo');
    
    // Extract playerId from URL
    const urlParams = new URLSearchParams(conn.url.split('?')[1]);
    let playerId = urlParams.get('playerId') || `anonymous-${Date.now()}`;
    
    console.log(`Player ID from connection: ${playerId}`);
    
    const stompConn = Stomp.over(conn);
    stompConn.heartbeat.outgoing = 10000;
    stompConn.heartbeat.incoming = 10000;
    
    connections.set(playerId, { stomp: stompConn, connected: true, lastHeartbeat: Date.now() });
    
    stompConn.connect({}, () => {
        console.log(`✅ STOMP connected: ${playerId} to Logo Bingo`);
        
        // Send welcome message
        stompConn.send(`/queue/popup_message-${playerId}`, {}, `Welcome to Logo Bingo!`);
        
        // Subscribe to user-specific queues
        stompConn.subscribe(`/queue/popup_message-${playerId}`, (msg) => {
            console.log(`Popup message for ${playerId}:`, msg.body);
        });
        
        stompConn.subscribe(`/queue/user_wallet-${playerId}`, (msg) => {
            console.log(`Wallet update for ${playerId}:`, msg.body);
        });
        
        // Handle sync state requests
        stompConn.subscribe('/app/syncState', (msg) => {
            try {
                const { playerId: pid, playerName } = JSON.parse(msg.body);
                console.log(`Sync state requested for ${pid}`);
                const state = gameEngine.getGameState(pid, playerName);
                stompConn.send('/user/queue/state', {}, JSON.stringify(state));
            } catch (error) {
                console.error('Sync state error:', error);
            }
        });
        
        // Handle bingo claims
        stompConn.subscribe('/app/claimBingo', (msg) => {
            try {
                const playerId = JSON.parse(msg.body);
                console.log(`🎯 BINGO claimed by player: ${playerId}`);
                const result = gameEngine.claimBingo(playerId);
                if (result.success) {
                    console.log(`✅ Valid BINGO! Broadcasting winners`);
                    broadcastToAll('/topic/game-over', JSON.stringify(result.winners));
                } else {
                    const playerConn = connections.get(playerId);
                    if (playerConn && playerConn.stomp && playerConn.stomp.connected) {
                        playerConn.stomp.send(`/queue/popup_message-${playerId}`, {}, '❌ No BINGO pattern found! Keep playing!');
                    }
                }
            } catch (error) {
                console.error('Claim Bingo error:', error);
            }
        });
        
        // Send initial state after connection
        setTimeout(() => {
            const state = gameEngine.getGameState(playerId, null);
            stompConn.send('/user/queue/state', {}, JSON.stringify(state));
        }, 500);
        
    }, (error) => {
        console.error(`STOMP connection error for ${playerId}:`, error);
        connections.delete(playerId);
    });
    
    conn.on('close', () => {
        console.log(`❌ Connection closed: ${playerId} from Logo Bingo`);
        const connData = connections.get(playerId);
        if (connData) {
            connData.connected = false;
        }
        connections.delete(playerId);
    });
    
    conn.on('error', (error) => {
        console.error(`WebSocket error for ${playerId}:`, error);
    });
});

sockjsServer.installHandlers(server, { prefix: '/ws' });

// ========== REST API Endpoints ==========

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString(), connections: connections.size });
});

app.get('/game/config', (req, res) => {
    res.json({
        numberOfCards: process.env.NUMBER_OF_CARDS || 500,
        gameVersion: '1.0.0',
        gameName: 'Logo Bingo'
    });
});

app.post('/game/join', async (req, res) => {
    const { name, id } = req.query;
    
    console.log(`Join request: name=${name}, id=${id}`);
    
    if (!id || !name) {
        return res.status(400).json({ error: 'Missing player info' });
    }
    
    try {
        let player = await db.getPlayer(id);
        if (!player) {
            player = await db.createPlayer(id, name);
        }
        
        gameEngine.addPlayer(id, name);
        
        // Send updated card owners to all
        const cardOwners = gameEngine.getCardOwners();
        broadcastToAll('/topic/cardOwners', JSON.stringify(cardOwners));
        
        console.log(`✅ Player ${name} (${id}) joined Logo Bingo`);
        res.json({ success: true, player, message: `Welcome to Logo Bingo, ${name}!` });
    } catch (error) {
        console.error('Join error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/game/state', async (req, res) => {
    const { playerId, playerName } = req.query;
    
    console.log(`State request for player: ${playerId}`);
    
    if (!playerId) {
        return res.status(400).json({ error: 'Player ID required' });
    }
    
    const state = gameEngine.getGameState(playerId, playerName);
    res.json(state);
});

app.post('/game/lockCard', async (req, res) => {
    const { cardId } = req.query;
    const userId = req.headers['user-id'];
    
    console.log(`Lock card request: userId=${userId}, cardId=${cardId}`);
    
    if (!userId || !cardId) {
        return res.status(400).json({ error: 'Missing parameters' });
    }
    
    try {
        const result = gameEngine.lockCard(userId, parseInt(cardId));
        
        // Broadcast updated card owners
        const cardOwners = gameEngine.getCardOwners();
        broadcastToAll('/topic/cardOwners', JSON.stringify(cardOwners));
        
        // Send wallet update to player
        const playerConn = connections.get(userId);
        if (playerConn && playerConn.stomp && playerConn.stomp.connected) {
            playerConn.stomp.send(`/queue/user_wallet-${userId}`, {}, JSON.stringify(result.wallet));
        }
        
        res.json(result);
    } catch (error) {
        console.error('Lock card error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Admin endpoints
app.post('/admin/start-game', (req, res) => {
    if (!isAdmin(req.headers['user-id'])) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    gameEngine.startGame();
    broadcastToAll('/topic/playroom_transit', JSON.stringify({
        activePlayersCount: gameEngine.getPlayerCount(),
        rewardAmount: gameEngine.getCurrentReward(),
        status: 'STARTING',
        playerCards: Array.from(gameEngine.players.entries()).map(([userId, player]) => ({
            userId: userId,
            card: player.cardId ? gameEngine.getCardById(player.cardId) : null
        }))
    }));
    
    res.json({ success: true, message: 'Logo Bingo game started!' });
});

app.post('/admin/draw-number', (req, res) => {
    if (!isAdmin(req.headers['user-id'])) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const number = gameEngine.drawNumber();
    const draws = gameEngine.getDraws();
    broadcastToAll('/topic/draws', JSON.stringify(draws));
    
    // Check for winners after each draw
    checkForWinners();
    
    res.json({ number, message: `Number ${number} drawn!`, draws: draws });
});

// Helper function to check winners after each draw
function checkForWinners() {
    const draws = new Set(gameEngine.getDraws());
    let winners = [];
    
    for (const [playerId, player] of gameEngine.players) {
        if (player.cardId) {
            const card = gameEngine.getCardById(player.cardId);
            if (card && gameEngine.checkWinningPattern(card.grid, draws)) {
                winners.push(playerId);
            }
        }
    }
    
    if (winners.length > 0 && !gameEngine.gameCompleted) {
        console.log(`🎉 Winners found: ${winners.join(', ')}`);
        for (const winnerId of winners) {
            const result = gameEngine.claimBingo(winnerId);
            if (result.success) {
                broadcastToAll('/topic/game-over', JSON.stringify(result.winners));
                gameEngine.gameCompleted = true;
                break;
            }
        }
    }
}

// Fixed broadcast function with dead connection cleanup
function broadcastToAll(topic, message) {
    let deadConnections = [];
    
    connections.forEach((connData, playerId) => {
        if (connData && connData.stomp && connData.stomp.connected) {
            try {
                connData.stomp.send(topic, {}, message);
                connData.lastHeartbeat = Date.now();
            } catch (e) {
                console.error(`Failed to broadcast to ${playerId}:`, e);
                deadConnections.push(playerId);
            }
        } else {
            deadConnections.push(playerId);
        }
    });
    
    // Clean up dead connections
    deadConnections.forEach(playerId => {
        connections.delete(playerId);
    });
    
    if (deadConnections.length > 0) {
        console.log(`Cleaned up ${deadConnections.length} dead connections`);
    }
}

function isAdmin(userId) {
    const adminIds = ['1765057062', '1044688332', '6499874707'];
    return adminIds.includes(userId);
}

// Timer broadcasts - FIXED
let lobbyTimerInterval = null;
let gameOverTimerInterval = null;

function startLobbyTimer() {
    if (lobbyTimerInterval) clearInterval(lobbyTimerInterval);
    
    lobbyTimerInterval = setInterval(() => {
        const timer = gameEngine.getLobbyTimer();
        if (timer !== null && timer >= 0) {
            broadcastToAll('/topic/lobbyTimer', JSON.stringify(timer));
            gameEngine.decrementLobbyTimer();
        }
        
        const cardOwners = gameEngine.getCardOwners();
        broadcastToAll('/topic/cardOwners', JSON.stringify(cardOwners));
        
        // Auto-start game when timer reaches 0
        if (timer === 0 && !gameEngine.gameActive) {
            console.log('⏰ Timer reached 0, auto-starting game...');
            gameEngine.startGame();
            broadcastToAll('/topic/playroom_transit', JSON.stringify({
                activePlayersCount: gameEngine.getPlayerCount(),
                rewardAmount: gameEngine.getCurrentReward(),
                status: 'STARTING'
            }));
        }
    }, 1000);
}

startLobbyTimer();

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🎮 Logo Bingo Server running on port ${PORT}`);
    console.log(`🌐 WebSocket endpoint: ws://0.0.0.0:${PORT}/ws`);
    console.log(`🌐 REST API endpoint: http://0.0.0.0:${PORT}`);
    console.log(`✅ Server is ready to accept connections`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, closing server...');
    if (lobbyTimerInterval) clearInterval(lobbyTimerInterval);
    if (gameOverTimerInterval) clearInterval(gameOverTimerInterval);
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
