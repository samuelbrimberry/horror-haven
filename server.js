require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const Stripe = require('stripe');
const { Filter } = require('bad-words');
const multer = require('multer');

const db = require('./db');

const app = express();
const server = http.createServer(app);
// Raised from Socket.IO's 1MB default so base64-encoded image/video
// attachments (up to ~8MB raw, larger once base64-encoded) can pass through.
const io = new Server(server, { maxHttpBufferSize: 15 * 1024 * 1024 });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const profanityFilter = new Filter();

// Attachments are stored inline as base64 in Postgres (no separate file
// storage service), so limits stay small to protect the free-tier DB quota.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_VIDEO_BYTES = 8 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_BYTES },
});

const PORT = process.env.PORT || 3000;
const ROOM_CATEGORIES = new Set(['movie', 'game', 'general']);
const PROTECTED_ROOM_SLUGS = new Set(['general', 'support', 'vip']);

// Tracks which sockets belong to which username, so a ban can disconnect
// someone's live connection immediately instead of waiting for their next action.
const activeSockets = new Map();

function registerSocket(username, socketId) {
  if (!activeSockets.has(username)) activeSockets.set(username, new Set());
  activeSockets.get(username).add(socketId);
}

function unregisterSocket(username, socketId) {
  const set = activeSockets.get(username);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) activeSockets.delete(username);
}

function kickUser(username) {
  const set = activeSockets.get(username);
  if (!set) return;
  set.forEach((socketId) => {
    const s = io.sockets.sockets.get(socketId);
    if (s) {
      s.emit('banned');
      s.disconnect(true);
    }
  });
}

function canAccessRoom(room, user) {
  return !room.isPremium || (user && (user.isPremium || user.isAdmin));
}

function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// Registered before express.json() because Stripe's signature check needs the
// raw, unparsed request body.
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    if (session.metadata && session.metadata.kind === 'username_change') {
      const userId = Number(session.metadata.userId);
      const newUsername = session.metadata.newUsername;
      const existing = await db.findUserByUsername(newUsername);
      if (userId && (!existing || existing.id === userId)) {
        await db.setUsername(userId, newUsername);
        await db.recordUsernameChange(userId);
      }
    } else {
      const userId = Number(session.client_reference_id);
      if (userId) {
        await db.setStripeInfo(userId, session.customer, session.subscription);
        await db.setPremium(userId, true);
      }
    }
  }

  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const isActive = subscription.status === 'active' || subscription.status === 'trialing';
    const user = await db.findUserByStripeCustomerId(subscription.customer);
    if (user) {
      await db.setPremium(user.id, isActive);
    }
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessionMiddleware = session({
  store: new FileStore({ path: path.join(__dirname, 'data', 'sessions') }),
  secret: process.env.SESSION_SECRET || 'horror-haven-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 },
});
app.use(sessionMiddleware);

// Share the Express session with Socket.IO connections so chat knows who's logged in.
io.use((socket, next) => sessionMiddleware(socket.request, {}, next));

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
  next();
}

function publicUser(user) {
  return { id: user.id, username: user.username, isPremium: user.isPremium, isAdmin: user.isAdmin };
}

async function requireAdmin(req, res, next) {
  const user = req.session.userId ? await db.findUserById(req.session.userId) : null;
  if (!user || !user.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  next();
}

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || username.length < 3 || password.length < 6) {
    return res.status(400).json({ error: 'Username must be 3+ chars and password 6+ chars.' });
  }
  if (await db.findUserByUsername(username)) {
    return res.status(400).json({ error: 'That username is already taken.' });
  }
  const passwordHash = bcrypt.hashSync(password, 10);
  let user = await db.createUser(username, passwordHash);
  const adminUsername = (process.env.ADMIN_USERNAME || '').toLowerCase();
  if (adminUsername && user.username.toLowerCase() === adminUsername) {
    user = await db.setAdmin(user.id, true);
  }
  req.session.userId = user.id;
  res.json(publicUser(user));
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  let user = await db.findUserByUsername(username || '');
  if (!user || !bcrypt.compareSync(password || '', user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  if (user.isBanned) {
    return res.status(403).json({ error: 'This account has been banned.' });
  }
  const adminUsername = (process.env.ADMIN_USERNAME || '').toLowerCase();
  if (adminUsername && user.username.toLowerCase() === adminUsername && !user.isAdmin) {
    user = await db.setAdmin(user.id, true);
  }
  req.session.userId = user.id;
  res.json(publicUser(user));
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', async (req, res) => {
  const user = req.session.userId ? await db.findUserById(req.session.userId) : null;
  res.json(user ? publicUser(user) : null);
});

const FREE_USERNAME_CHANGES_PER_30_DAYS = 2;

function validateUsername(username) {
  if (!username || username.trim().length < 3 || username.trim().length > 20) {
    return 'Username must be 3-20 characters.';
  }
  return null;
}

app.post('/api/settings/username', requireAuth, async (req, res) => {
  const { username } = req.body || {};
  const validationError = validateUsername(username);
  if (validationError) return res.status(400).json({ error: validationError });

  const trimmed = username.trim();
  const existing = await db.findUserByUsername(trimmed);
  if (existing && existing.id !== req.session.userId) {
    return res.status(400).json({ error: 'That username is already taken.' });
  }

  const recentChanges = await db.countRecentUsernameChanges(req.session.userId);
  if (recentChanges >= FREE_USERNAME_CHANGES_PER_30_DAYS) {
    return res.status(402).json({
      error: `You've used your ${FREE_USERNAME_CHANGES_PER_30_DAYS} free name changes in the last 30 days. A $3 fee applies to change it again.`,
      requiresPayment: true,
    });
  }

  const user = await db.setUsername(req.session.userId, trimmed);
  await db.recordUsernameChange(req.session.userId);
  res.json(publicUser(user));
});

app.post('/api/settings/username/checkout', requireAuth, async (req, res) => {
  const { username } = req.body || {};
  const validationError = validateUsername(username);
  if (validationError) return res.status(400).json({ error: validationError });

  const trimmed = username.trim();
  const existing = await db.findUserByUsername(trimmed);
  if (existing && existing.id !== req.session.userId) {
    return res.status(400).json({ error: 'That username is already taken.' });
  }

  const origin = `${req.protocol}://${req.get('host')}`;
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ price: process.env.STRIPE_USERNAME_CHANGE_PRICE_ID, quantity: 1 }],
    metadata: {
      kind: 'username_change',
      userId: String(req.session.userId),
      newUsername: trimmed,
    },
    success_url: `${origin}/settings.html?nameChangePaid=1`,
    cancel_url: `${origin}/settings.html?nameChangePaid=0`,
  });

  res.json({ url: session.url });
});

app.post('/api/create-checkout-session', requireAuth, async (req, res) => {
  const user = await db.findUserById(req.session.userId);
  if (user.isPremium) {
    return res.status(400).json({ error: 'Already Premium.' });
  }

  const origin = `${req.protocol}://${req.get('host')}`;
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
    customer: user.stripeCustomerId || undefined,
    client_reference_id: String(user.id),
    success_url: `${origin}/app.html?upgraded=1`,
    cancel_url: `${origin}/app.html?upgraded=0`,
  });

  res.json({ url: session.url });
});

const ALLOWED_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime',
]);

app.post('/api/upload', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  // Only ever embed a whitelisted mimetype in the data: URL — the client
  // controls this header, so passing it through unchecked would let a
  // crafted Content-Type break out of the src="..." attribute (XSS).
  if (!ALLOWED_MIME_TYPES.has(req.file.mimetype)) {
    return res.status(400).json({ error: 'Unsupported file type. Use PNG, JPEG, GIF, WebP, MP4, WebM, or MOV.' });
  }

  const isImage = req.file.mimetype.startsWith('image/');
  const maxBytes = isImage ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (req.file.size > maxBytes) {
    return res.status(400).json({ error: `File too large. Max ${Math.round(maxBytes / (1024 * 1024))}MB for ${isImage ? 'images' : 'videos'}.` });
  }

  const dataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
  res.json({ url: dataUrl, type: isImage ? 'image' : 'video' });
});

app.get('/api/rooms', async (req, res) => {
  const rooms = await db.listRooms();
  res.json(rooms);
});

app.post('/api/rooms', requireAuth, async (req, res) => {
  const { name, category } = req.body || {};
  if (!name || !name.trim() || name.trim().length > 60) {
    return res.status(400).json({ error: 'Room name must be 1-60 characters.' });
  }
  if (!ROOM_CATEGORIES.has(category)) {
    return res.status(400).json({ error: 'Category must be "movie", "game", or "general".' });
  }
  const slug = slugify(name);
  if (!slug) {
    return res.status(400).json({ error: 'Room name must include letters or numbers.' });
  }
  const user = await db.findUserById(req.session.userId);
  const room = await db.createRoom(slug, name.trim(), category, user.username);
  res.json(room);
});

app.post('/api/create-portal-session', requireAuth, async (req, res) => {
  const user = await db.findUserById(req.session.userId);
  if (!user.stripeCustomerId) {
    return res.status(400).json({ error: 'No billing account yet — subscribe to Premium first.' });
  }
  const origin = `${req.protocol}://${req.get('host')}`;
  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: `${origin}/settings.html`,
  });
  res.json({ url: session.url });
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const users = await db.listUsers();
  res.json(users.map((u) => ({
    id: u.id,
    username: u.username,
    isPremium: u.isPremium,
    isAdmin: u.isAdmin,
    isBanned: u.isBanned,
    createdAt: u.createdAt,
  })));
});

app.post('/api/admin/users/:id/ban', requireAdmin, async (req, res) => {
  const user = await db.setBanned(Number(req.params.id), true);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  kickUser(user.username);
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/unban', requireAdmin, async (req, res) => {
  const user = await db.setBanned(Number(req.params.id), false);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({ ok: true });
});

app.post('/api/reports', requireAuth, async (req, res) => {
  const { messageId, room, reportedUsername, messageText, reason } = req.body || {};
  if (!room || !reportedUsername || !messageText) {
    return res.status(400).json({ error: 'Missing report details.' });
  }
  const reporter = await db.findUserById(req.session.userId);
  if (reporter.username === reportedUsername) {
    return res.status(400).json({ error: "You can't report your own message." });
  }
  const reportedUser = await db.findUserByUsername(reportedUsername);
  const report = await db.createReport({
    messageId: messageId || null,
    room,
    reportedUserId: reportedUser ? reportedUser.id : null,
    reportedUsername,
    reporterUsername: reporter.username,
    messageText: String(messageText).slice(0, 500),
    reason: reason ? String(reason).slice(0, 300) : null,
  });
  res.json(report);
});

app.get('/api/admin/reports', requireAdmin, async (req, res) => {
  const reports = await db.listReports('open');
  res.json(reports);
});

app.post('/api/admin/reports/:id/resolve', requireAdmin, async (req, res) => {
  const report = await db.resolveReport(Number(req.params.id));
  if (!report) return res.status(404).json({ error: 'Report not found.' });
  res.json(report);
});

app.get('/api/admin/messages/:roomSlug', requireAdmin, async (req, res) => {
  const messages = await db.getRecentMessages(req.params.roomSlug, 200);
  res.json(messages);
});

app.delete('/api/admin/messages/:id', requireAdmin, async (req, res) => {
  const deleted = await db.deleteMessage(Number(req.params.id));
  res.json({ ok: deleted });
});

app.delete('/api/admin/rooms/:slug', requireAdmin, async (req, res) => {
  if (PROTECTED_ROOM_SLUGS.has(req.params.slug)) {
    return res.status(400).json({ error: 'This room is built-in and cannot be deleted.' });
  }
  const deleted = await db.deleteRoom(req.params.slug);
  res.json({ ok: deleted });
});

// Catches multer errors (e.g. file too large) so they return a clean JSON
// response instead of Express's default HTML error page.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: 'File too large or invalid upload.' });
  }
  next(err);
});

io.on('connection', (socket) => {
  let knownUsername = null;

  const getUser = async () => {
    const uid = socket.request.session && socket.request.session.userId;
    const user = uid ? await db.findUserById(uid) : null;
    if (user && knownUsername !== user.username) {
      if (knownUsername) unregisterSocket(knownUsername, socket.id);
      knownUsername = user.username;
      registerSocket(knownUsername, socket.id);
    }
    return user;
  };

  socket.on('join', async (roomSlug) => {
    const targetRoom = await db.findRoomBySlug(roomSlug);
    if (!targetRoom) return;
    const user = await getUser();
    if (!canAccessRoom(targetRoom, user)) {
      socket.emit('error-message', `${targetRoom.name} is for premium members only.`);
      return;
    }
    socket.join(targetRoom.slug);
    socket.emit('history', await db.getRecentMessages(targetRoom.slug));
  });

  socket.on('message', async ({ room: roomSlug, text, attachment } = {}) => {
    const user = await getUser();
    if (!user) {
      socket.emit('error-message', 'You must be logged in to chat.');
      return;
    }
    if (user.isBanned) {
      socket.emit('error-message', 'Your account has been banned.');
      return;
    }

    const hasAttachment = attachment && typeof attachment.url === 'string' && attachment.url.startsWith('data:')
      && (attachment.type === 'image' || attachment.type === 'video');
    const trimmed = (text || '').trim().slice(0, 500);
    if (!trimmed && !hasAttachment) return;

    const targetRoom = await db.findRoomBySlug(roomSlug);
    if (!targetRoom) return;
    if (!canAccessRoom(targetRoom, user)) return;

    const cleaned = trimmed ? profanityFilter.clean(trimmed) : '';
    const msg = await db.addMessage(
      targetRoom.slug,
      user.username,
      cleaned,
      hasAttachment ? attachment.url : null,
      hasAttachment ? attachment.type : null
    );
    io.to(targetRoom.slug).emit('message', msg);
  });

  socket.on('disconnect', () => {
    if (knownUsername) unregisterSocket(knownUsername, socket.id);
  });
});

db.init()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Horror Haven is running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
