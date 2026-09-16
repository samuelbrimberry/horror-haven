require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const Stripe = require('stripe');

const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PORT = process.env.PORT || 3000;
const ROOM_CATEGORIES = new Set(['movie', 'game', 'general']);

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
    const userId = Number(session.client_reference_id);
    if (userId) {
      await db.setStripeInfo(userId, session.customer, session.subscription);
      await db.setPremium(userId, true);
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
  return { id: user.id, username: user.username, isPremium: user.isPremium };
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
  const user = await db.createUser(username, passwordHash);
  req.session.userId = user.id;
  res.json(publicUser(user));
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const user = await db.findUserByUsername(username || '');
  if (!user || !bcrypt.compareSync(password || '', user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
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

io.on('connection', (socket) => {
  const getUser = () => {
    const uid = socket.request.session && socket.request.session.userId;
    return uid ? db.findUserById(uid) : null;
  };

  socket.on('join', async (roomSlug) => {
    const targetRoom = await db.findRoomBySlug(roomSlug);
    if (!targetRoom) return;
    const user = await getUser();
    if (targetRoom.isPremium && !(user && user.isPremium)) {
      socket.emit('error-message', `${targetRoom.name} is for premium members only.`);
      return;
    }
    socket.join(targetRoom.slug);
    socket.emit('history', await db.getRecentMessages(targetRoom.slug));
  });

  socket.on('message', async ({ room: roomSlug, text } = {}) => {
    const user = await getUser();
    if (!user) {
      socket.emit('error-message', 'You must be logged in to chat.');
      return;
    }
    if (!text || !text.trim()) return;
    const targetRoom = await db.findRoomBySlug(roomSlug);
    if (!targetRoom) return;
    if (targetRoom.isPremium && !user.isPremium) return;
    const msg = await db.addMessage(targetRoom.slug, user.username, text.trim().slice(0, 500));
    io.to(targetRoom.slug).emit('message', msg);
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
