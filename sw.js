/*
 * 서비스 워커: 화면 파일(HTML·CSS·JS)을 기기에 저장해 오프라인에서도 페이지가 열리게 한다.
 * - 같은 출처의 파일만 다룬다. Apps Script(script.google.com) 요청은 건드리지 않는다.
 * - 저장본을 먼저 보여 주고 뒤에서 새 버전을 받아 둔다 → 레포에 푸시한 변경은 다음 열 때 반영.
 */
var CACHE = 'eink-v1';
var SHELL = ['./', 'index.html', 'assets/style.css', 'assets/app.js', 'manifest.webmanifest', 'assets/icons/icon-192.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // 쿼리(?demo=1, ?t=...)는 저장 키에서 무시한다
  e.respondWith(caches.open(CACHE).then(function (c) {
    return c.match(req, { ignoreSearch: true }).then(function (hit) {
      var fresh = fetch(req).then(function (res) {
        if (res && res.ok) c.put(req.url.split('?')[0], res.clone());
        return res;
      }).catch(function () { return hit || Response.error(); });
      return hit || fresh;
    });
  }));
});
