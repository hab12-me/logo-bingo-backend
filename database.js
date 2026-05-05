class Database {
  constructor() {
    this.players = new Map();
    this.games = new Map();
    this.scores = new Map();
  }
  
  async getPlayer(playerId) {
    return this.players.get(playerId) || null;
  }
  
  async createPlayer(playerId, playerName) {
    const player = {
      id: playerId,
      name: playerName,
      createdAt: new Date(),
      totalWins: 0,
      totalPlayed: 0,
      totalWinnings: 0
    };
    this.players.set(playerId, player);
    console.log(`New Logo Bingo player created: ${playerName} (${playerId})`);
    return player;
  }
  
  async updatePlayerStats(playerId, won, winnings = 0) {
    const player = this.players.get(playerId);
    if (player) {
      player.totalPlayed++;
      if (won) {
        player.totalWins++;
        player.totalWinnings += winnings;
      }
      this.players.set(playerId, player);
      console.log(`Updated Logo Bingo stats for ${player.name}: ${player.totalWins} wins`);
    }
  }
  
  async saveGame(gameData) {
    const gameId = Date.now().toString();
    this.games.set(gameId, {
      ...gameData,
      timestamp: new Date(),
      gameName: 'Logo Bingo'
    });
    return gameId;
  }
  
  async getTopScores(limit = 10) {
    const scores = Array.from(this.players.values())
      .sort((a, b) => b.totalWinnings - a.totalWinnings)
      .slice(0, limit)
      .map(p => ({ name: p.name, wins: p.totalWins, winnings: p.totalWinnings }));
    return scores;
  }
  
  async getPlayerStats(playerId) {
    return this.players.get(playerId) || null;
  }
}

module.exports = Database;
