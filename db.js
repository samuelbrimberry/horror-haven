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

  await pool.query('ALTER TABLE rooms ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT FALSE;');
  await pool.query('ALTER TABLE rooms ADD COLUMN IF NOT EXISTS access_mode TEXT;');
  await pool.query('ALTER TABLE rooms ADD COLUMN IF NOT EXISTS invite_code TEXT;');
  await pool.query('ALTER TABLE rooms ADD COLUMN IF NOT EXISTS password_hash TEXT;');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS rooms_invite_code_idx ON rooms (invite_code) WHERE invite_code IS NOT NULL;');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS room_members (
      room_id INTEGER NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (room_id, user_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS friend_requests (
      id SERIAL PRIMARY KEY,
      requester_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      recipient_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS friend_requests_pending_idx
      ON friend_requests (LEAST(requester_id, recipient_id), GREATEST(requester_id, recipient_id))
      WHERE status = 'pending';
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
    isPrivate: row.is_private,
    accessMode: row.access_mode,
  };
}

function rowToFriendRequest(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    requesterId: row.requester_id,
    recipientId: row.recipient_id,
    status: row.status,
    createdAt: row.created_at,
    otherUsername: row.other_username,
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
    const { rows } = await pool.query('SELECT * FROM rooms WHERE is_private = FALSE ORDER BY category, name');
    return rows.map(rowToRoom);
  },

  async findRoomBySlug(slug) {
    const { rows } = await pool.query('SELECT * FROM rooms WHERE slug = $1', [slug]);
    return rowToRoom(rows[0]);
  },

  async createRoom(slug, name, category, createdBy, opts = {}) {
    const { isPrivate = false, accessMode = null, inviteCode = null, passwordHash = null } = opts;
    const { rows } = await pool.query(
      `INSERT INTO rooms (slug, name, category, is_premium, created_by, is_private, access_mode, invite_code, password_hash)
       VALUES ($1, $2, $3, FALSE, $4, $5, $6, $7, $8)
       ON CONFLICT (slug) DO NOTHING
       RETURNING *`,
      [slug, name, category, createdBy, isPrivate, accessMode, inviteCode, passwordHash]
    );
    if (rows[0]) return rowToRoom(rows[0]);
    return this.findRoomBySlug(slug);
  },

  async listMyPrivateRooms(userId) {
    const { rows } = await pool.query(
      `SELECT r.* FROM rooms r
       JOIN room_members m ON m.room_id = r.id
       WHERE m.user_id = $1 AND r.is_private = TRUE AND r.category != 'dm'
       ORDER BY r.name`,
      [userId]
    );
    return rows.map(rowToRoom);
  },

  async addRoomMember(roomId, userId) {
    await pool.query(
      'INSERT INTO room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [roomId, userId]
    );
  },

  async isRoomMember(roomId, userId) {
    const { rows } = await pool.query(
      'SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2',
      [roomId, userId]
    );
    return rows.length > 0;
  },

  async findRoomByInviteCode(code) {
    const { rows } = await pool.query('SELECT * FROM rooms WHERE invite_code = $1', [code]);
    return rowToRoom(rows[0]);
  },

  async findRoomPasswordHash(roomId) {
    const { rows } = await pool.query('SELECT password_hash FROM rooms WHERE id = $1', [roomId]);
    return rows[0] ? rows[0].password_hash : null;
  },

  async createFriendRequest(requesterId, recipientId) {
    const { rows } = await pool.query(
      'INSERT INTO friend_requests (requester_id, recipient_id) VALUES ($1, $2) RETURNING *',
      [requesterId, recipientId]
    );
    return rowToFriendRequest(rows[0]);
  },

  async findPendingRequestBetween(userIdA, userIdB) {
    const { rows } = await pool.query(
      `SELECT * FROM friend_requests
       WHERE status = 'pending'
         AND ((requester_id = $1 AND recipient_id = $2) OR (requester_id = $2 AND recipient_id = $1))`,
      [userIdA, userIdB]
    );
    return rowToFriendRequest(rows[0]);
  },

  async areFriends(userIdA, userIdB) {
    const { rows } = await pool.query(
      `SELECT 1 FROM friend_requests
       WHERE status = 'accepted'
         AND ((requester_id = $1 AND recipient_id = $2) OR (requester_id = $2 AND recipient_id = $1))`,
      [userIdA, userIdB]
    );
    return rows.length > 0;
  },

  async findFriendRequestById(id) {
    const { rows } = await pool.query('SELECT * FROM friend_requests WHERE id = $1', [id]);
    return rowToFriendRequest(rows[0]);
  },

  async setFriendRequestStatus(id, status) {
    const { rows } = await pool.query(
      'UPDATE friend_requests SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );
    return rowToFriendRequest(rows[0]);
  },

  async listIncomingRequests(userId) {
    const { rows } = await pool.query(
      `SELECT fr.*, u.username AS other_username FROM friend_requests fr
       JOIN users u ON u.id = fr.requester_id
       WHERE fr.recipient_id = $1 AND fr.status = 'pending'
       ORDER BY fr.created_at DESC`,
      [userId]
    );
    return rows.map(rowToFriendRequest);
  },

  async listOutgoingRequests(userId) {
    const { rows } = await pool.query(
      `SELECT fr.*, u.username AS other_username FROM friend_requests fr
       JOIN users u ON u.id = fr.recipient_id
       WHERE fr.requester_id = $1 AND fr.status = 'pending'
       ORDER BY fr.created_at DESC`,
      [userId]
    );
    return rows.map(rowToFriendRequest);
  },

  async listFriends(userId) {
    const { rows } = await pool.query(
      `SELECT u.id, u.username FROM friend_requests fr
       JOIN users u ON u.id = CASE WHEN fr.requester_id = $1 THEN fr.recipient_id ELSE fr.requester_id END
       WHERE fr.status = 'accepted' AND (fr.requester_id = $1 OR fr.recipient_id = $1)
       ORDER BY u.username`,
      [userId]
    );
    return rows;
  },

  async findOrCreateDmRoom(userIdA, userIdB) {
    const [lo, hi] = [userIdA, userIdB].sort((a, b) => a - b);
    const slug = `dm-${lo}-${hi}`;
    let room = await this.findRoomBySlug(slug);
    if (!room) {
      room = await this.createRoom(slug, 'Direct Message', 'dm', null, { isPrivate: true });
      await this.addRoomMember(room.id, lo);
      await this.addRoomMember(room.id, hi);
    }
    return room;
  },

  async listMyDms(userId) {
    const { rows } = await pool.query(
      `SELECT r.*, u.username AS other_username, u.id AS other_user_id
       FROM rooms r
       JOIN room_members m ON m.room_id = r.id AND m.user_id = $1
       JOIN room_members m2 ON m2.room_id = r.id AND m2.user_id != $1
       JOIN users u ON u.id = m2.user_id
       WHERE r.category = 'dm'
       ORDER BY r.created_at DESC`,
      [userId]
    );
    return rows.map((row) => ({ ...rowToRoom(row), otherUsername: row.other_username, otherUserId: row.other_user_id }));
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
