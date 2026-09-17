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
  await loadFriends();
  await joinFromInviteLink();
}

async function joinFromInviteLink() {
  const params = new URLSearchParams(window.location.search);
  const invite = params.get('invite');
  if (!invite) return;
  window.history.replaceState({}, '', '/app.html');

  const res = await fetch('/api/rooms/private/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inviteCode: invite }),
  });
  const room = await res.json();
  if (!res.ok) {
    appendSystemMessage(room.error || 'Could not join that room.');
    return;
  }
  await loadRooms();
  switchRoom(room, true);
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
  const [publicRes, privateRes, dmRes] = await Promise.all([
    fetch('/api/rooms'),
    fetch('/api/rooms/private'),
    fetch('/api/dms'),
  ]);
  roomsCache = await publicRes.json();
  const privateRooms = await privateRes.json();
  const dms = await dmRes.json();

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

  if (privateRooms.length > 0) {
    const heading = document.createElement('div');
    heading.className = 'room-section-title';
    heading.textContent = '🔒 Private Rooms';
    container.appendChild(heading);

    privateRooms.forEach((room) => {
      const btn = document.createElement('button');
      btn.className = 'room-btn' + (room.slug === currentRoom ? ' active' : '');
      btn.textContent = room.name;
      btn.addEventListener('click', () => switchRoom(room, true));
      container.appendChild(btn);
    });
  }

  if (dms.length > 0) {
    const heading = document.createElement('div');
    heading.className = 'room-section-title';
    heading.textContent = '✉️ Direct Messages';
    container.appendChild(heading);

    dms.forEach((dm) => {
      const btn = document.createElement('button');
      btn.className = 'room-btn' + (dm.slug === currentRoom ? ' active' : '');
      btn.textContent = dm.otherUsername;
      btn.addEventListener('click', () => switchRoom({ ...dm, name: dm.otherUsername }, true));
      container.appendChild(btn);
    });
  }
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

async function loadFriends() {
  const res = await fetch('/api/friends');
  if (!res.ok) return;
  const data = await res.json();
  renderFriendsPanel(data);

  const badge = document.getElementById('friends-badge');
  if (data.incoming.length > 0) {
    badge.hidden = false;
    badge.textContent = String(data.incoming.length);
  } else {
    badge.hidden = true;
  }
}

function renderFriendsPanel(data) {
  const incomingEl = document.getElementById('friends-incoming');
  const outgoingEl = document.getElementById('friends-outgoing');
  const friendsEl = document.getElementById('friends-list');

  incomingEl.innerHTML = data.incoming.length
    ? '<div class="room-section-title">Incoming requests</div>' + data.incoming.map((r) => `
      <div class="friend-row" data-request-id="${r.id}">
        <span>${escapeHtml(r.otherUsername)}</span>
        <span class="row-actions">
          <button class="btn btn-ghost accept-request-btn">Accept</button>
          <button class="btn btn-ghost decline-request-btn">Decline</button>
        </span>
      </div>`).join('')
    : '';

  outgoingEl.innerHTML = data.outgoing.length
    ? '<div class="room-section-title">Pending (sent by you)</div>' + data.outgoing.map((r) => `
      <div class="friend-row"><span>${escapeHtml(r.otherUsername)}</span><span class="badge free">Pending</span></div>`).join('')
    : '';

  friendsEl.innerHTML = data.friends.length
    ? '<div class="room-section-title">Friends</div>' + data.friends.map((f) => `
      <div class="friend-row" data-username="${escapeHtml(f.username)}">
        <span>${escapeHtml(f.username)}</span>
        <span class="row-actions"><button class="btn message-friend-btn">Message</button></span>
      </div>`).join('')
    : '<div class="room-section-title">Friends</div><p style="color: var(--text-dim); font-size: 0.88rem;">No friends yet — add one above.</p>';

  incomingEl.querySelectorAll('.accept-request-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const id = e.target.closest('.friend-row').dataset.requestId;
      await fetch(`/api/friends/${id}/accept`, { method: 'POST' });
      await loadFriends();
    });
  });
  incomingEl.querySelectorAll('.decline-request-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const id = e.target.closest('.friend-row').dataset.requestId;
      await fetch(`/api/friends/${id}/decline`, { method: 'POST' });
      await loadFriends();
    });
  });
  friendsEl.querySelectorAll('.message-friend-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const username = e.target.closest('.friend-row').dataset.username;
      await openDm(username);
    });
  });
}

async function openDm(username) {
  const res = await fetch(`/api/dms/${encodeURIComponent(username)}`, { method: 'POST' });
  const room = await res.json();
  if (!res.ok) {
    appendSystemMessage(room.error || 'Could not open that conversation.');
    return;
  }
  document.getElementById('friends-overlay').hidden = true;
  await loadRooms();
  switchRoom({ ...room, name: room.otherUsername }, true);
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

  const privateCheckbox = document.getElementById('new-room-private');
  const categorySelect = document.getElementById('new-room-category');
  const accessModeSelect = document.getElementById('new-room-access-mode');
  const passwordInput = document.getElementById('new-room-password');

  function syncPrivateRoomFields() {
    const isPrivate = privateCheckbox.checked;
    categorySelect.hidden = isPrivate;
    accessModeSelect.hidden = !isPrivate;
    passwordInput.hidden = !isPrivate || accessModeSelect.value !== 'password';
  }

  privateCheckbox.addEventListener('change', syncPrivateRoomFields);
  accessModeSelect.addEventListener('change', syncPrivateRoomFields);

  document.getElementById('new-room-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const nameInput = document.getElementById('new-room-name');
    const name = nameInput.value.trim();
    if (!name) return;

    let res;
    if (privateCheckbox.checked) {
      res = await fetch('/api/rooms/private', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, accessMode: accessModeSelect.value, password: passwordInput.value }),
      });
    } else {
      res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, category: categorySelect.value }),
      });
    }
    const room = await res.json();
    if (!res.ok) {
      appendSystemMessage(room.error || 'Could not create room.');
      return;
    }
    nameInput.value = '';
    passwordInput.value = '';
    if (room.inviteCode) {
      appendSystemMessage(`Private room created. Share this invite link: ${window.location.origin}/app.html?invite=${room.inviteCode}`);
    } else {
      appendSystemMessage(`Private room created. Share this Room ID (and your password) with friends: ${room.slug}`);
    }
    await loadRooms();
    switchRoom(room, true);
  });

  document.getElementById('join-private-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const inviteInput = document.getElementById('join-invite-code');
    const nameInput = document.getElementById('join-room-name');
    const passwordInput2 = document.getElementById('join-room-password');
    const inviteCode = inviteInput.value.trim();
    const slugExact = nameInput.value.trim();

    if (!inviteCode && !slugExact) return;

    const res = await fetch('/api/rooms/private/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inviteCode: inviteCode || undefined, slug: slugExact || undefined, password: passwordInput2.value }),
    });
    const room = await res.json();
    if (!res.ok) {
      appendSystemMessage(room.error || 'Could not join that room.');
      return;
    }
    inviteInput.value = '';
    nameInput.value = '';
    passwordInput2.value = '';
    await loadRooms();
    switchRoom(room, true);
  });

  document.getElementById('friends-btn').addEventListener('click', async () => {
    document.getElementById('friends-overlay').hidden = false;
    await loadFriends();
  });

  document.getElementById('friends-close-btn').addEventListener('click', () => {
    document.getElementById('friends-overlay').hidden = true;
  });

  document.getElementById('add-friend-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('add-friend-username');
    const username = input.value.trim();
    if (!username) return;

    const res = await fetch('/api/friends/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    });
    const data = await res.json();
    if (!res.ok) {
      appendSystemMessage(data.error || 'Could not send friend request.');
      return;
    }
    input.value = '';
    await loadFriends();
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
