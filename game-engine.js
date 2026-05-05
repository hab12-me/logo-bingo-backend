class GameEngine {
  constructor() {
    this.players = new Map();
    this.cards = new Map();
    this.draws = [];
    this.gameActive = false;
    this.gameCompleted = false;  // ADDED: Track if game completed
    this.lobbyTimer = 30;
    this.currentReward = 1000;
    this.numberOfCards = parseInt(process.env.NUMBER_OF_CARDS) || 500;
    
    this.initializeCards();
  }
  
  initializeCards() {
    for (let id = 1; id <= this.numberOfCards; id++) {
      this.cards.set(id, {
        id: id,
        grid: this.generateBingoCard(),
        lockedBy: null,
        lockedAt: null
      });
    }
    console.log(`Initialized ${this.numberOfCards} Logo Bingo cards`);
  }
  
  generateBingoCard() {
    const grid = Array(5).fill().map(() => Array(5).fill(0));
    
    const ranges = [
      [1, 15],
      [16, 30],
      [31, 45],
      [46, 60],
      [61, 75]
    ];
    
    for (let col = 0; col < 5; col++) {
      const [min, max] = ranges[col];
      const numbers = new Set();
      
      while (numbers.size < 5) {
        const num = Math.floor(Math.random() * (max - min + 1)) + min;
        numbers.add(num);
      }
      
      const colNumbers = Array.from(numbers);
      for (let row = 0; row < 5; row++) {
        grid[row][col] = colNumbers[row];
      }
    }
    
    grid[2][2] = 0; // Free space
    
    return grid;
  }
  
  // ADDED: Get card by ID
  getCardById(cardId) {
    return this.cards.get(cardId) || null;
  }
  
  addPlayer(playerId, playerName) {
    if (!this.players.has(playerId)) {
      this.players.set(playerId, {
        id: playerId,
        name: playerName,
        cardId: null,
        wallet: 1000,
        dismissed: false,
        joinedAt: Date.now()
      });
      console.log(`Player ${playerName} (${playerId}) added to Logo Bingo`);
      console.log(`Total players: ${this.players.size}`);
    }
    return this.players.get(playerId);
  }
  
  lockCard(playerId, cardId) {
    const player = this.players.get(playerId);
    if (!player) {
      throw new Error('Player not found');
    }
    
    const card = this.cards.get(cardId);
    if (!card) {
      throw new Error('Card not found');
    }
    
    // Check if card is already locked by another player
    if (card.lockedBy && card.lockedBy !== playerId) {
      return {
        status: 'error',
        message: 'This Logo Bingo card is already taken by another player!',
        wallet: player.wallet
      };
    }
    
    // Unlock previous card if exists
    if (player.cardId) {
      const oldCard = this.cards.get(player.cardId);
      if (oldCard) {
        oldCard.lockedBy = null;
        oldCard.lockedAt = null;
        console.log(`Unlocked card ${player.cardId} from player ${playerId}`);
      }
    }
    
    // Lock new card
    card.lockedBy = playerId;
    card.lockedAt = Date.now();
    player.cardId = cardId;
    
    console.log(`Player ${playerId} locked card ${cardId}`);
    
    return {
      status: 'success',
      message: player.cardId === cardId ? 'Logo Bingo card locked!' : 'Logo Bingo card changed!',
      card: {
        id: cardId,
        grid: card.grid
      },
      wallet: player.wallet
    };
  }
  
  getGameState(playerId, playerName) {
    const player = this.players.get(playerId);
    const card = player && player.cardId ? this.cards.get(player.cardId) : null;
    
    // If player doesn't exist, create them
    if (!player && playerId) {
      console.log(`Creating new player via state request: ${playerId}`);
      this.addPlayer(playerId, playerName || `Player_${playerId}`);
      return this.getGameState(playerId, playerName);
    }
    
    return {
      roomId: this.gameActive ? 'PLAYROOM' : 'LOBBY',
      lobbyTimer: this.lobbyTimer,
      wallet: player ? player.wallet : 0,
      cardOwners: this.getCardOwners(),
      playerCount: this.players.size,
      reward: this.currentReward,
      draws: this.draws,
      user: {
        card: card ? {
          id: card.id,
          grid: card.grid
        } : null,
        wallet: player ? player.wallet : 0,
        dismissed: player ? player.dismissed : false
      },
      gameRound: 1,
      status: this.gameActive ? 'STARTED' : 'WAITING'
    };
  }
  
  getCardOwners() {
    const owners = {};
    for (const [cardId, card] of this.cards) {
      if (card.lockedBy) {
        owners[cardId] = card.lockedBy;
      }
    }
    return owners;
  }
  
  startGame() {
    if (this.gameActive) {
      console.log('Game already active');
      return;
    }
    
    if (this.players.size === 0) {
      console.log('Cannot start game: No players');
      return;
    }
    
    this.gameActive = true;
    this.gameCompleted = false;
    this.draws = [];
    this.currentReward = 1000 + (this.players.size * 100);
    this.lobbyTimer = null;
    
    console.log(`🎮 Logo Bingo game started with ${this.players.size} players!`);
    console.log(`💰 Jackpot: ${this.currentReward}`);
  }
  
  drawNumber() {
    if (!this.gameActive) {
      console.log('Game not active, cannot draw');
      return null;
    }
    
    if (this.draws.length >= 75) {
      console.log('All numbers have been drawn!');
      return null;
    }
    
    let number;
    do {
      number = Math.floor(Math.random() * 75) + 1;
    } while (this.draws.includes(number));
    
    this.draws.push(number);
    console.log(`🎲 Number drawn: ${number} (Total draws: ${this.draws.length})`);
    return number;
  }
  
  claimBingo(playerId) {
    const player = this.players.get(playerId);
    if (!player || !player.cardId) {
      console.log(`Bingo claim failed: Player ${playerId} has no card`);
      return { success: false };
    }
    
    const card = this.cards.get(player.cardId);
    if (!card) {
      console.log(`Bingo claim failed: Card ${player.cardId} not found`);
      return { success: false };
    }
    
    const drawnSet = new Set(this.draws);
    const winningNumbers = this.checkWinningPattern(card.grid, drawnSet);
    
    if (winningNumbers.length > 0) {
      // Add winnings to player wallet
      const oldWallet = player.wallet;
      player.wallet += this.currentReward;
      
      console.log(`🎉 BINGO! ${player.name} (${playerId}) won!`);
      console.log(`💰 Wallet: ${oldWallet} → ${player.wallet} (+${this.currentReward})`);
      
      const winners = [{
        playerName: player.name,
        card: {
          id: card.id,
          grid: card.grid
        },
        winningNumbers: winningNumbers
      }];
      
      // End the game
      this.gameActive = false;
      this.gameCompleted = true;
      this.lobbyTimer = 30;
      
      // Reset all card locks for next game
      for (const [cid, c] of this.cards) {
        c.lockedBy = null;
        c.lockedAt = null;
      }
      
      // Reset player cards for next game
      for (const [pid, p] of this.players) {
        p.cardId = null;
      }
      
      return {
        success: true,
        winners: {
          winners: winners,
          drawnNumbers: this.draws
        }
      };
    }
    
    console.log(`Bingo claim failed: No winning pattern for ${player.name}`);
    return { success: false };
  }
  
  checkWinningPattern(card, drawnSet) {
    const winningNumbers = [];
    
    // Check rows
    for (let row = 0; row < 5; row++) {
      let rowComplete = true;
      for (let col = 0; col < 5; col++) {
        const value = card[row][col];
        if (value !== 0 && !drawnSet.has(value)) {
          rowComplete = false;
          break;
        }
      }
      if (rowComplete) {
        for (let col = 0; col < 5; col++) {
          if (card[row][col] !== 0) {
            winningNumbers.push(card[row][col]);
          }
        }
      }
    }
    
    // Check columns
    for (let col = 0; col < 5; col++) {
      let colComplete = true;
      for (let row = 0; row < 5; row++) {
        const value = card[row][col];
        if (value !== 0 && !drawnSet.has(value)) {
          colComplete = false;
          break;
        }
      }
      if (colComplete) {
        for (let row = 0; row < 5; row++) {
          if (card[row][col] !== 0) {
            winningNumbers.push(card[row][col]);
          }
        }
      }
    }
    
    // Check diagonals
    let diag1Complete = true;
    let diag2Complete = true;
    
    for (let i = 0; i < 5; i++) {
      const val1 = card[i][i];
      const val2 = card[i][4 - i];
      
      if (val1 !== 0 && !drawnSet.has(val1)) diag1Complete = false;
      if (val2 !== 0 && !drawnSet.has(val2)) diag2Complete = false;
    }
    
    if (diag1Complete) {
      for (let i = 0; i < 5; i++) {
        if (card[i][i] !== 0) winningNumbers.push(card[i][i]);
      }
    }
    
    if (diag2Complete) {
      for (let i = 0; i < 5; i++) {
        if (card[i][4 - i] !== 0) winningNumbers.push(card[i][4 - i]);
      }
    }
    
    return [...new Set(winningNumbers)];
  }
  
  getPlayerCount() {
    return this.players.size;
  }
  
  getCurrentReward() {
    return this.currentReward;
  }
  
  getDraws() {
    return [...this.draws];
  }
  
  getLobbyTimer() {
    return this.lobbyTimer;
  }
  
  decrementLobbyTimer() {
    if (this.lobbyTimer !== null && this.lobbyTimer > 0) {
      this.lobbyTimer--;
      if (this.lobbyTimer % 5 === 0) {
        console.log(`Lobby timer: ${this.lobbyTimer} seconds remaining`);
      }
    }
  }
  
  // ADDED: Reset game for new round
  resetGame() {
    this.gameActive = false;
    this.gameCompleted = false;
    this.draws = [];
    this.lobbyTimer = 30;
    this.currentReward = 1000;
    
    // Reset all card locks
    for (const [cardId, card] of this.cards) {
      card.lockedBy = null;
      card.lockedAt = null;
    }
    
    // Reset all player cards
    for (const [playerId, player] of this.players) {
      player.cardId = null;
      player.dismissed = false;
    }
    
    console.log('Game reset for new round');
  }
  
  // ADDED: Get player by ID
  getPlayer(playerId) {
    return this.players.get(playerId) || null;
  }
  
  // ADDED: Get all players
  getAllPlayers() {
    return Array.from(this.players.values());
  }
}

module.exports = GameEngine;
