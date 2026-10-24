/*
 * 서비스 워커: 화면 파일(HTML·CSS·JS)을 기기에 저장해 오프라인에서도 페이지가 열리게 한다.
 * - 같은 출처의 파일만 다룬다. Apps Script(script.google.com) 요청은 건드리지 않는다.
 * - 인터넷이 되면 늘 새 파일을 받는다(네트워크 우선) → 레포에 푸시한 변경이 '다시 불러오기' 한 번에 반영.
 *   인터넷이 없거나 5초 안에 응답이 없으면 저장본을 보여준다.
 * - GitHub Pages 는 파일을 10분간 브라우저 캐시에 두게 하므로 no-cache 로 매번 서버에 확인한다.
 */
var CACHE = 'eink-v2';
var SHELL = ['./', 'index.html', 'assets/style.css', 'assets/app.js', 'manifest.webmanifest', 'assets/icons/icon-192.png'];
var NETWORK_TIMEOUT_MS = 5000;

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
  var key = req.url.split('?')[0];
  e.respondWith(caches.open(CACHE).then(function (c) {
    var fromCache = function () {
      return c.match(req, { ignoreSearch: true }).then(function (hit) { return hit || Response.error(); });
    };
    var fromNetwork = fetch(req, { cache: 'no-cache' }).then(function (res) {
      if (res && res.ok) c.put(key, res.clone());
      return res;
    });
    var timeout = new Promise(function (resolve, reject) {
      setTimeout(function () { reject(new Error('timeout')); }, NETWORK_TIMEOUT_MS);
    });
    return Promise.race([fromNetwork, timeout])['catch'](fromCache);
  }));
});
