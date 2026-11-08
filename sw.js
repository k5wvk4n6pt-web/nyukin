/* オフライン用：アプリ本体だけを保存する（家計データはここに含まれない） */
const CACHE = 'kakeibo-app-v114';
const FILES = ['./', 'index.html', 'native.js', 'calc.js', 'app.js', 'manifest.webmanifest', 'hero.png', 'logo-text.png', 'logo-wave.png', 'logo-outline.png', 'icon-blue-180.png', 'icon-pink-180.png', 'icon-green-180.png', 'icon-purple-180.png', 'icon-orange-180.png', 'icon-192-v3.png', 'icon-512-v3.png', 'apple-touch-icon-v3.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  const path = new URL(req.url).pathname.split('/').pop() || './';
  const isApp = FILES.includes(path) || path === './';
  if (!isApp) {
    // サポート・プライバシーポリシーなどは、いつも最新を取りに行く（つながらないときだけ保存分）
    e.respondWith(fetch(req).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || Response.error())));
    return;
  }
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => req.mode === 'navigate' ? caches.match('index.html') : Response.error()))
  );
});
