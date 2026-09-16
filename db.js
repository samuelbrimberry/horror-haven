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
  await pool.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_url TEXT;');
  await pool.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_type TEXT;');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN NOT NULL DEFAULT FALSE;');

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id SERIAL PRIMARY KEY,
      message_id INTEGER,
      room TEXT NOT NULL,
      reported_user_id INTEGER,
      reported_username TEXT NOT NULL,
      reporter_username TEXT NOT NULL,
      message_text TEXT NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS username_changes (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
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
    isAdmin: row.is_admin,
    isBanned: row.is_banned,
  };
}

function rowToReport(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    messageId: row.message_id,
    room: row.room,
    reportedUserId: row.reported_user_id,
    reportedUsername: row.reported_username,
    reporterUsername: row.reporter_username,
    messageText: row.message_text,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
  };
}

function rowToMessage(row) {
  return {
    id: row.id,
    room: row.room,
    username: row.username,
    text: row.text,
    attachmentUrl: row.attachment_url,
    attachmentType: row.attachment_type,
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

  async setUsername(id, newUsername) {
    const { rows } = await pool.query('UPDATE users SET username = $1 WHERE id = $2 RETURNING *', [newUsername, id]);
    return rowToUser(rows[0]);
  },

  async countRecentUsernameChanges(userId) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM username_changes WHERE user_id = $1 AND created_at > now() - interval '30 days'`,
      [userId]
    );
    return rows[0].count;
  },

  async recordUsernameChange(userId) {
    await pool.query('INSERT INTO username_changes (user_id) VALUES ($1)', [userId]);
  },

  async setAdmin(id, value) {
    const { rows } = await pool.query('UPDATE users SET is_admin = $1 WHERE id = $2 RETURNING *', [value, id]);
    return rowToUser(rows[0]);
  },

  async setBanned(id, value) {
    const { rows } = await pool.query('UPDATE users SET is_banned = $1 WHERE id = $2 RETURNING *', [value, id]);
    return rowToUser(rows[0]);
  },

  async listUsers() {
    const { rows } = await pool.query('SELECT * FROM users ORDER BY created_at DESC');
    return rows.map(rowToUser);
  },

  async addMessage(room, username, text, attachmentUrl = null, attachmentType = null) {
    const { rows } = await pool.query(
      `INSERT INTO messages (room, username, text, attachment_url, attachment_type)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [room, username, text, attachmentUrl, attachmentType]
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

  async deleteMessage(id) {
    const { rowCount } = await pool.query('DELETE FROM messages WHERE id = $1', [id]);
    return rowCount > 0;
  },

  async deleteRoom(slug) {
    await pool.query('DELETE FROM messages WHERE room = $1', [slug]);
    const { rowCount } = await pool.query('DELETE FROM rooms WHERE slug = $1', [slug]);
    return rowCount > 0;
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

  async createReport({ messageId, room, reportedUserId, reportedUsername, reporterUsername, messageText, reason }) {
    const { rows } = await pool.query(
      `INSERT INTO reports (message_id, room, reported_user_id, reported_username, reporter_username, message_text, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [messageId, room, reportedUserId, reportedUsername, reporterUsername, messageText, reason || null]
    );
    return rowToReport(rows[0]);
  },

  async listReports(status = 'open') {
    const { rows } = await pool.query('SELECT * FROM reports WHERE status = $1 ORDER BY created_at DESC', [status]);
    return rows.map(rowToReport);
  },

  async resolveReport(id) {
    const { rows } = await pool.query(
      `UPDATE reports SET status = 'resolved' WHERE id = $1 RETURNING *`,
      [id]
    );
    return rowToReport(rows[0]);
  },
};
