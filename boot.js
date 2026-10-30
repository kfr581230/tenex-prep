// Starts the app, registers the offline service worker, and shows an update banner
// instead of reloading in the middle of a study session.
(function () {
  const cfg = window.APP_CONFIG || {};
  window.Flashcards.mountReview(document.getElementById('app'), window.DECKS || [], cfg);

  const net = document.getElementById('net-status');
  const status = () => { net.textContent = navigator.onLine ? 'online' : 'offline ✓ all cards available'; };
  addEventListener('online', status); addEventListener('offline', status); status();
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}

  if (!('serviceWorker' in navigator)) return;
  const showVersion = () => 'caches' in window && caches.keys().then(keys => {
    const v = keys.find(k => k.startsWith('cards-'));
    if (v) document.getElementById('app-version').textContent = 'version ' + v.replace('cards-', '');
  });
  showVersion();
  navigator.serviceWorker.ready.then(showVersion); // first visit: the cache exists only after install
  const bar = document.getElementById('update-bar');
  const hadController = !!navigator.serviceWorker.controller; // first install takes control silently
  let refreshing = false;
  navigator.serviceWorker.register('./sw.js').then(reg => {
    const offer = w => { bar.hidden = false; document.getElementById('update-btn').onclick = () => w.postMessage('update'); };
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w && w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); });
    });
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !refreshing) { refreshing = true; location.reload(); }
  });
})();
