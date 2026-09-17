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
let pendingAttachment = null;

const AD_UNITS = [
  { title: 'Ecoflarix 4-in-1 Milk Frother', price: '$54.99', url: 'https://amzn.to/4AmKpjy' },
  { title: 'LEGO Star Wars Advent Calendar 2026', price: '$35.00', url: 'https://amzn.to/4dJdyLV' },
];

function renderAd() {
  const container = document.getElementById('ad-content');
  if (!container) return;
  const ad = AD_UNITS[Math.floor(Math.random() * AD_UNITS.length)];
  container.innerHTML = `
    <a class="ad-unit" href="${ad.url}" target="_blank" rel="noopener sponsored">
      <span class="ad-label">Ad</span>
      <span><span class="ad-title">${escapeHtml(ad.title)}</span><span class="ad-price">${escapeHtml(ad.price)}</span></span>
    </a>
  `;
}

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
  const hasFullAccess = currentUser.isPremium || currentUser.isAdmin;
  let tier = '<span class="badge free">Free</span>';
  if (currentUser.isAdmin) tier = '<span class="badge gold">Admin</span>';
  else if (currentUser.isPremium) tier = '<span class="badge gold">Premium</span>';
  badge.innerHTML = `${currentUser.username} ${tier}`;

  document.getElementById('ad-slot').hidden = hasFullAccess;
  document.getElementById('upgrade-btn').hidden = hasFullAccess;
  if (!hasFullAccess) renderAd();

  if (currentUser.isAdmin) document.getElementById('admin-link').hidden = false;
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
      const unlocked = !room.isPremium || (currentUser && (currentUser.isPremium || currentUser.isAdmin));
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

  socket.on('banned', async () => {
    alert('Your account has been banned.');
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/';
  });
}

function renderMessage(msg) {
  const el = document.createElement('div');
  el.className = 'msg';
  const isMe = currentUser && msg.username === currentUser.username;
  const time = new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  el.innerHTML = `
    <div class="who ${isMe ? 'me' : ''}">${escapeHtml(msg.username)}<span class="time">${time}</span></div>
    ${msg.text ? `<div class="body">${escapeHtml(msg.text)}</div>` : ''}
  `;

  if (msg.attachmentUrl) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-attachment';
    if (msg.attachmentType === 'video') {
      wrap.innerHTML = `<video src="${msg.attachmentUrl}" controls></video>`;
    } else {
      wrap.innerHTML = `<img src="${msg.attachmentUrl}" alt="attachment" />`;
    }
    el.appendChild(wrap);
  }

  if (!isMe) {
    const reportBtn = document.createElement('button');
    reportBtn.className = 'report-btn';
    reportBtn.textContent = '🚩 Report';
    reportBtn.addEventListener('click', () => reportMessage(msg));
    el.appendChild(reportBtn);
  }

  document.getElementById('messages').appendChild(el);
}

async function reportMessage(msg) {
  const reason = prompt(`Report ${msg.username}'s message? Add an optional reason:`);
  if (reason === null) return;
  const res = await fetch('/api/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messageId: msg.id,
      room: currentRoom,
      reportedUsername: msg.username,
      messageText: msg.text,
      reason,
    }),
  });
  const data = await res.json();
  appendSystemMessage(res.ok ? 'Report sent to the moderators.' : (data.error || 'Could not send report.'));
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

function showAttachmentPreview() {
  const preview = document.getElementById('attachment-preview');
  if (!pendingAttachment) {
    preview.hidden = true;
    preview.innerHTML = '';
    return;
  }
  preview.hidden = false;
  const mediaHtml = pendingAttachment.type === 'video'
    ? `<video src="${pendingAttachment.url}" muted></video>`
    : `<img src="${pendingAttachment.url}" alt="attachment preview" />`;
  preview.innerHTML = `${mediaHtml}<span>Ready to send</span>`;
  const removeBtn = document.createElement('button');
  removeBtn.className = 'remove-attachment';
  removeBtn.textContent = 'Remove';
  removeBtn.addEventListener('click', () => {
    pendingAttachment = null;
    showAttachmentPreview();
  });
  preview.appendChild(removeBtn);
}

function setupUi() {
  document.getElementById('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('chat-text');
    const text = input.value.trim();
    if (!text && !pendingAttachment) return;
    socket.emit('message', { room: currentRoom, text, attachment: pendingAttachment });
    input.value = '';
    pendingAttachment = null;
    showAttachmentPreview();
  });

  document.getElementById('attach-btn').addEventListener('click', () => {
    document.getElementById('attach-input').click();
  });

  document.getElementById('attach-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) {
      appendSystemMessage(data.error || 'Could not upload file.');
      return;
    }
    pendingAttachment = { url: data.url, type: data.type };
    showAttachmentPreview();
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
