(async function () {
  const loginLink = document.getElementById('nav-login');
  const joinLink = document.getElementById('nav-join');
  if (!loginLink || !joinLink) return;

  const res = await fetch('/api/me');
  const user = await res.json();
  if (!user) return;

  loginLink.remove();
  const hasChatLink = !!document.querySelector('.nav-links a[href="/app.html"]');
  joinLink.outerHTML = `
    ${hasChatLink ? '' : '<a href="/app.html">Chat</a>'}
    <a href="/settings.html">Settings</a>
    <span class="nav-username" id="nav-username"></span>
    <button class="btn btn-ghost" id="nav-logout">Log out</button>
  `;
  document.getElementById('nav-username').textContent = user.username;

  document.getElementById('nav-logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/';
  });
})();
