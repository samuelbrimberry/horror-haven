const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'db.json');

function load() {
  if (!fs.existsSync(DB_PATH)) {
    return { users: [], messages: [], nextUserId: 1, nextMessageId: 1 };
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
}

const state = load();

function save() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(state, null, 2));
}

module.exports = {
  findUserByUsername(username) {
    return state.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  },

  findUserById(id) {
    return state.users.find((u) => u.id === id);
  },

  createUser(username, passwordHash) {
    const user = {
      id: state.nextUserId++,
      username,
      passwordHash,
      isPremium: false,
      createdAt: new Date().toISOString(),
    };
    state.users.push(user);
    save();
    return user;
  },

  setPremium(id, value) {
    const user = this.findUserById(id);
    if (user) {
      user.isPremium = value;
      save();
    }
    return user;
  },

  addMessage(room, username, text) {
    const msg = {
      id: state.nextMessageId++,
      room,
      username,
      text,
      createdAt: new Date().toISOString(),
    };
    state.messages.push(msg);
    if (state.messages.length > 5000) {
      state.messages = state.messages.slice(-5000);
    }
    save();
    return msg;
  },

  getRecentMessages(room, limit = 50) {
    return state.messages.filter((m) => m.room === room).slice(-limit);
  },
};
