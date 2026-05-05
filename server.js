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

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Store active STOMP connections
let connections = new Map();

// SockJS/STOMP setup
const sockjsServer = SockJS.createServer({
  sockjs_url: 'https://cdn.jsdelivr.net/npm/sockjs-client@1/dist/sockjs.min.js'
});

// STOMP over SockJS
sockjsServer.on('connection', (conn) => {
  console.log('New WebSocket connection to Logo Bingo');
  
  const stompConn = Stomp.over(conn);
  const playerId = conn.url.split('playerId=')[1] || `anonymous-${Date.now()}`;
  
  connections.set(playerId, stompConn);
  
  stompConn.connect({}, () => {
    console.log(`STOMP connected: ${playerId} to Logo Bingo`);
    
    stompConn.subscribe(`/queue/popup_message-${playerId}`, (msg) => {
      console.log(`Popup message for ${playerId}:`, msg.body);
    });
    
    stompConn.subscribe(`/queue/user_wallet-${playerId}`, (msg) => {
      console.log(`Wallet update for ${playerId}:`, msg.body);
    });
    
    stompConn.subscribe('/app/syncState', (msg) => {
      const { playerId, playerName } = JSON.parse(msg.body);
      const state = gameEngine.getGameState(playerId, playerName);
      stompConn.send('/user/queue/state', {}, JSON.stringify(state));
    });
    
    stompConn.subscribe('/app/claimBingo', (msg) => {
      const playerId = JSON.parse(msg.body);
      const result = gameEngine.claimBingo(playerId);
      if (result.success) {
        broadcastToAll('/topic/game-over', JSON.stringify(result.winners));
      } else {
        const playerConn = connections.get(playerId);
        if (playerConn) {
          playerConn.send(`/queue/popup_message-${playerId}`, {}, 'No BINGO pattern found! Keep playing!');
        }
      }
    });
  });
  
  conn.on('close', () => {
    console.log(`Connection closed: ${playerId} from Logo Bingo`);
    connections.delete(playerId);
  });
});

sockjsServer.installHandlers(server, { prefix: '/ws' });

// REST API Endpoints
app.get('/game/config', (req, res) => {
  res.json({
    numberOfCards: process.env.NUMBER_OF_CARDS || 500,
    gameVersion: '1.0.0',
    gameName: 'Logo Bingo'
  });
});

app.post('/game/join', async (req, res) => {
  const { name, id } = req.query;
  
  if (!id || !name) {
    return res.status(400).json({ error: 'Missing player info' });
  }
  
  try {
    let player = await db.getPlayer(id);
    if (!player) {
      player = await db.createPlayer(id, name);
    }
    
    gameEngine.addPlayer(id, name);
    
    console.log(`Player ${name} (${id}) joined Logo Bingo`);
    res.json({ success: true, player, message: `Welcome to Logo Bingo, ${name}!` });
  } catch (error) {
    console.error('Join error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/game/state', async (req, res) => {
  const { playerId, playerName } = req.query;
  
  if (!playerId) {
    return res.status(400).json({ error: 'Player ID required' });
  }
  
  const state = gameEngine.getGameState(playerId, playerName);
  res.json(state);
});

app.post('/game/lockCard', async (req, res) => {
  const { cardId } = req.query;
  const userId = req.headers['user-id'];
  
  if (!userId || !cardId) {
    return res.status(400).json({ error: 'Missing parameters' });
  }
  
  try {
    const result = gameEngine.lockCard(userId, parseInt(cardId));
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
    status: 'STARTING'
  }));
  
  res.json({ success: true, message: 'Logo Bingo game started!' });
});

app.post('/admin/draw-number', (req, res) => {
  if (!isAdmin(req.headers['user-id'])) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  
  const number = gameEngine.drawNumber();
  broadcastToAll('/topic/draws', JSON.stringify(gameEngine.getDraws()));
  
  res.json({ number, message: `Number ${number} drawn!` });
});

// Helper functions
function broadcastToAll(topic, message) {
  connections.forEach((conn, playerId) => {
    if (conn && conn.connected) {
      try {
        conn.send(topic, {}, message);
      } catch (e) {
        console.error(`Failed to broadcast to ${playerId}:`, e);
      }
    }
  });
}

function isAdmin(userId) {
  const adminIds = ['1765057062', '1044688332', '6499874707'];
  return adminIds.includes(userId);
}

// Timer broadcasts
let lobbyTimerInterval = null;

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
  }, 1000);
}

startLobbyTimer();

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Logo Bingo Server running on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);
  console.log(`REST API endpoint: http://localhost:${PORT}`);
});
