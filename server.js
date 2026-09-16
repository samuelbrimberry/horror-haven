require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');

const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ROOMS = ['general', 'movies', 'games', 'support', 'vip'];
const PREMIUM_ROOMS = new Set(['vip']);

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

// DEMO ONLY: instantly flips the account to premium so you can see the gated
// features work. Swap this for a real Stripe Checkout session + webhook
// before taking real payments — see README.md "Turning on real payments".
app.post('/api/upgrade', requireAuth, async (req, res) => {
  const user = await db.setPremium(req.session.userId, true);
  res.json(publicUser(user));
});

app.get('/api/rooms', async (req, res) => {
  const user = req.session.userId ? await db.findUserById(req.session.userId) : null;
  const rooms = ROOMS.filter((r) => !PREMIUM_ROOMS.has(r) || (user && user.isPremium));
  res.json(rooms);
});

io.on('connection', (socket) => {
  const getUser = () => {
    const uid = socket.request.session && socket.request.session.userId;
    return uid ? db.findUserById(uid) : null;
  };

  socket.on('join', async (room) => {
    if (!ROOMS.includes(room)) return;
    const user = await getUser();
    if (PREMIUM_ROOMS.has(room) && !(user && user.isPremium)) {
      socket.emit('error-message', 'The VIP Lounge is for premium members only.');
      return;
    }
    socket.join(room);
    socket.emit('history', await db.getRecentMessages(room));
  });

  socket.on('message', async ({ room, text } = {}) => {
    const user = await getUser();
    if (!user) {
      socket.emit('error-message', 'You must be logged in to chat.');
      return;
    }
    if (!ROOMS.includes(room) || !text || !text.trim()) return;
    if (PREMIUM_ROOMS.has(room) && !user.isPremium) return;
    const msg = await db.addMessage(room, user.username, text.trim().slice(0, 500));
    io.to(room).emit('message', msg);
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
