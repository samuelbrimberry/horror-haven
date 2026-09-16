const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_premium BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      room TEXT NOT NULL,
      username TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS messages_room_idx ON messages (room, id);');
}

function rowToUser(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    isPremium: row.is_premium,
    createdAt: row.created_at,
  };
}

function rowToMessage(row) {
  return {
    id: row.id,
    room: row.room,
    username: row.username,
    text: row.text,
    createdAt: row.created_at,
  };
}

module.exports = {
  init,

  async findUserByUsername(username) {
    const { rows } = await pool.query('SELECT * FROM users WHERE lower(username) = lower($1)', [username]);
    return rowToUser(rows[0]);
  },

  async findUserById(id) {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return rowToUser(rows[0]);
  },

  async createUser(username, passwordHash) {
    const { rows } = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING *',
      [username, passwordHash]
    );
    return rowToUser(rows[0]);
  },

  async setPremium(id, value) {
    const { rows } = await pool.query(
      'UPDATE users SET is_premium = $1 WHERE id = $2 RETURNING *',
      [value, id]
    );
    return rowToUser(rows[0]);
  },

  async addMessage(room, username, text) {
    const { rows } = await pool.query(
      'INSERT INTO messages (room, username, text) VALUES ($1, $2, $3) RETURNING *',
      [room, username, text]
    );
    return rowToMessage(rows[0]);
  },

  async getRecentMessages(room, limit = 50) {
    const { rows } = await pool.query(
      'SELECT * FROM messages WHERE room = $1 ORDER BY id DESC LIMIT $2',
      [room, limit]
    );
    return rows.reverse().map(rowToMessage);
  },
};
