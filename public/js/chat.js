const CATEGORY_ICON = {
  general: '💬',
  support: '🕯️',
  movie: '🎬',
  game: '🎮',
  vip: '👑',
};

const CATEGORY_LABEL = {
  general: 'General',
  support: 'Support',
  movie: 'Movies',
  game: 'Games',
  vip: 'VIP',
};

const CATEGORY_ORDER = ['general', 'support', 'movie', 'game', 'vip'];

let currentUser = null;
let currentRoom = 'general';
let currentRoomName = 'General';
let socket = null;
let roomsCache = [];

async function init() {
  const res = await fetch('/api/me');
  currentUser = await res.json();

  if (!currentUser) {
    window.location.href = '/login.html';
    return;
  }

  renderUserBadge();
  await loadRooms();
  connectSocket();
  setupUi();
}

function renderUserBadge() {
  const badge = document.getElementById('user-badge');
  const tier = currentUser.isPremium
    ? '<span class="badge gold">Premium</span>'
    : '<span class="badge free">Free</span>';
  badge.innerHTML = `${currentUser.username} ${tier}`;

  const adSlot = document.getElementById('ad-slot');
  if (currentUser.isPremium) adSlot.hidden = true;

  const upgradeBtn = document.getElementById('upgrade-btn');
  if (!currentUser.isPremium) upgradeBtn.hidden = false;
}

async function loadRooms() {
  const res = await fetch('/api/rooms');
  roomsCache = await res.json();
  const container = document.getElementById('room-buttons');
  container.innerHTML = '';

  CATEGORY_ORDER.forEach((category) => {
    const roomsInCategory = roomsCache.filter((r) => r.category === category);
    if (roomsInCategory.length === 0) return;

    const heading = document.createElement('div');
    heading.className = 'room-section-title';
    heading.textContent = `${CATEGORY_ICON[category]} ${CATEGORY_LABEL[category]}`;
    container.appendChild(heading);

    roomsInCategory.forEach((room) => {
      const unlocked = !room.isPremium || (currentUser && currentUser.isPremium);
      const btn = document.createElement('button');
      btn.className = 'room-btn' + (room.slug === currentRoom ? ' active' : '') + (unlocked ? '' : ' locked');
      btn.textContent = room.name + (unlocked ? '' : ' 🔒');
      btn.addEventListener('click', () => switchRoom(room, unlocked));
      container.appendChild(btn);
    });
  });
}

function switchRoom(room, unlocked) {
  if (!unlocked) {
    appendSystemMessage(`${room.name} is for Premium members. Click "Go Premium" to unlock it.`);
    return;
  }
  currentRoom = room.slug;
  currentRoomName = room.name;
  document.getElementById('room-title').textContent = room.name;
  document.getElementById('messages').innerHTML = '';
  loadRooms();
  socket.emit('join', room.slug);
}

function connectSocket() {
  socket = io();

  socket.on('connect', () => {
    socket.emit('join', currentRoom);
  });

  socket.on('history', (messages) => {
    document.getElementById('messages').innerHTML = '';
    messages.forEach(renderMessage);
    scrollToBottom();
  });

  socket.on('message', (msg) => {
    renderMessage(msg);
    scrollToBottom();
  });

  socket.on('error-message', (text) => {
    appendSystemMessage(text);
  });
}

function renderMessage(msg) {
  const el = document.createElement('div');
  el.className = 'msg';
  const isMe = currentUser && msg.username === currentUser.username;
  const time = new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  el.innerHTML = `
    <div class="who ${isMe ? 'me' : ''}">${escapeHtml(msg.username)}<span class="time">${time}</span></div>
    <div class="body">${escapeHtml(msg.text)}</div>
  `;
  document.getElementById('messages').appendChild(el);
}

function appendSystemMessage(text) {
  const el = document.createElement('div');
  el.className = 'msg system';
  el.innerHTML = `<div class="body">${escapeHtml(text)}</div>`;
  document.getElementById('messages').appendChild(el);
  scrollToBottom();
}

function scrollToBottom() {
  const box = document.getElementById('messages');
  box.scrollTop = box.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function setupUi() {
  document.getElementById('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('chat-text');
    const text = input.value.trim();
    if (!text) return;
    socket.emit('message', { room: currentRoom, text });
    input.value = '';
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/';
  });

  document.getElementById('new-room-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const nameInput = document.getElementById('new-room-name');
    const categorySelect = document.getElementById('new-room-category');
    const name = nameInput.value.trim();
    if (!name) return;

    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, category: categorySelect.value }),
    });
    const room = await res.json();
    if (!res.ok) {
      appendSystemMessage(room.error || 'Could not create room.');
      return;
    }
    nameInput.value = '';
    await loadRooms();
    switchRoom(room, true);
  });

  document.getElementById('upgrade-btn').addEventListener('click', async () => {
    const res = await fetch('/api/create-checkout-session', { method: 'POST' });
    const data = await res.json();
    if (res.ok && data.url) {
      window.location.href = data.url;
    } else {
      appendSystemMessage(data.error || 'Could not start checkout. Try again.');
    }
  });
}

async function checkUpgradeReturn() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('upgraded') !== '1') return;
  window.history.replaceState({}, '', '/app.html');

  appendSystemMessage('Payment received! Activating your Premium membership...');
  // Stripe's webhook can take a few seconds to reach us, so poll briefly
  // rather than assuming the upgrade landed the instant Checkout redirects back.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const res = await fetch('/api/me');
    const user = await res.json();
    if (user && user.isPremium) {
      currentUser = user;
      renderUserBadge();
      loadRooms();
      appendSystemMessage('You are now a Premium member! The VIP Lounge is unlocked.');
      return;
    }
  }
  appendSystemMessage("Payment received, but activation is taking longer than expected — refresh in a moment.");
}

init().then(checkUpgradeReturn);
