async function submitAuth(url, body) {
  const errorEl = document.getElementById('error');
  errorEl.textContent = '';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || 'Something went wrong.';
      return;
    }
    window.location.href = '/app.html';
  } catch (err) {
    errorEl.textContent = 'Network error. Try again.';
  }
}
