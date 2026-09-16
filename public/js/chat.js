const ROOM_LABELS = {
  general: '💬 General',
  movies: '🎬 Movies',
  games: '🎮 Games',
  support: '🕯️ Support',
  vip: '👑 VIP Lounge',
};

let currentUser = null;
let currentRoom = 'general';
let socket = null;

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
  const availableRooms = await res.json();
  const allRooms = Object.keys(ROOM_LABELS);
  const list = document.getElementById('room-list');
  list.innerHTML = '';

  allRooms.forEach((room) => {
    const unlocked = availableRooms.includes(room);
    const btn = document.createElement('button');
    btn.className = 'room-btn' + (room === currentRoom ? ' active' : '') + (unlocked ? '' : ' locked');
    btn.textContent = ROOM_LABELS[room] + (unlocked ? '' : ' 🔒');
    btn.addEventListener('click', () => switchRoom(room, unlocked));
    list.appendChild(btn);
  });
}

function switchRoom(room, unlocked) {
  if (!unlocked) {
    appendSystemMessage('This room is for Premium members. Click "Go Premium" to unlock it.');
    return;
  }
  currentRoom = room;
  document.getElementById('room-title').textContent = ROOM_LABELS[room];
  document.getElementById('messages').innerHTML = '';
  loadRooms();
  socket.emit('join', room);
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

  document.getElementById('upgrade-btn').addEventListener('click', async () => {
    const res = await fetch('/api/upgrade', { method: 'POST' });
    if (res.ok) {
      currentUser = await res.json();
      document.getElementById('upgrade-btn').hidden = true;
      renderUserBadge();
      loadRooms();
      appendSystemMessage('You are now a Premium member! The VIP Lounge is unlocked.');
    }
  });
}

init();
