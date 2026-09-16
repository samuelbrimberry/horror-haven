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
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      is_premium BOOLEAN NOT NULL DEFAULT FALSE,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const defaultRooms = [
    { slug: 'general', name: 'General', category: 'general', isPremium: false },
    { slug: 'support', name: 'Support', category: 'support', isPremium: false },
    { slug: 'vip', name: 'VIP Lounge', category: 'vip', isPremium: true },
  ];
  for (const room of defaultRooms) {
    await pool.query(
      `INSERT INTO rooms (slug, name, category, is_premium)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (slug) DO NOTHING`,
      [room.slug, room.name, room.category, room.isPremium]
    );
  }
}

function rowToUser(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    isPremium: row.is_premium,
    createdAt: row.created_at,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
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

function rowToRoom(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    category: row.category,
    isPremium: row.is_premium,
    createdBy: row.created_by,
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

  async setStripeInfo(id, stripeCustomerId, stripeSubscriptionId) {
    const { rows } = await pool.query(
      'UPDATE users SET stripe_customer_id = $1, stripe_subscription_id = $2 WHERE id = $3 RETURNING *',
      [stripeCustomerId, stripeSubscriptionId, id]
    );
    return rowToUser(rows[0]);
  },

  async findUserByStripeCustomerId(stripeCustomerId) {
    const { rows } = await pool.query('SELECT * FROM users WHERE stripe_customer_id = $1', [stripeCustomerId]);
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

  async listRooms() {
    const { rows } = await pool.query('SELECT * FROM rooms ORDER BY category, name');
    return rows.map(rowToRoom);
  },

  async findRoomBySlug(slug) {
    const { rows } = await pool.query('SELECT * FROM rooms WHERE slug = $1', [slug]);
    return rowToRoom(rows[0]);
  },

  async createRoom(slug, name, category, createdBy) {
    const { rows } = await pool.query(
      `INSERT INTO rooms (slug, name, category, is_premium, created_by)
       VALUES ($1, $2, $3, FALSE, $4)
       ON CONFLICT (slug) DO NOTHING
       RETURNING *`,
      [slug, name, category, createdBy]
    );
    if (rows[0]) return rowToRoom(rows[0]);
    return this.findRoomBySlug(slug);
  },
};
