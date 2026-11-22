// Guarda la app (no la música) para que abra sin conexión.
const CACHE = 'sonora-v3';
const APP = ['./', './index.html', './drive.js', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
// Google (inicio de sesión y Drive) va siempre directo a la red: no está en CDN.
const CDN = ['cdn.tailwindcss.com', 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(APP)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === location.origin;
  if (!sameOrigin && !CDN.includes(url.hostname)) return; // audio de enlaces: directo a la red

  // La página: primero la red (para recibir actualizaciones), si falla, la copia guardada.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req)
      .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put('./index.html', copy)); return res; })
      .catch(() => caches.match('./index.html')));
    return;
  }

  // Archivos de la app (drive.js, íconos…): primero la red, para no mezclar versiones con index.html.
  if (sameOrigin) {
    e.respondWith(fetch(req)
      .then(res => { if (res.status === 200 && !req.headers.has('range')) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); } return res; })
      .catch(() => caches.match(req)));
    return;
  }

  // Librerías de CDN: la copia guardada, y se refresca en segundo plano.
  e.respondWith(caches.match(req).then(hit => {
    const net = fetch(req).then(res => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => hit);
    return hit || net;
  }));
});
