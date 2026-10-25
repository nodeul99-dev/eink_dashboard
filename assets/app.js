/*
 * 업무 캘린더 + 독서 인용구 전자잉크 대시보드
 *
 * 구형 안드로이드 웹뷰를 고려해 ES5 로만 작성한다 (화살표 함수·let·옵셔널 체이닝 금지).
 *
 * - 데이터는 Apps Script 웹앱에서 한 번에 받는다 (일정 2주치 + 인용구 전체).
 *   네트워크는 핫스팟을 켤 때만 있다고 가정하고, 받은 데이터는 localStorage 에 둔다.
 *   '오늘', '다음 일정', '지금 인용구'는 전부 기기 시계로 계산한다.
 * - 동기화 시점: 페이지 열 때, 네트워크가 연결되는 순간(online), 화면을 탭할 때, 30분마다.
 * - 잔상 줄이기: 내용이 바뀐 영역만 다시 그린다. 화면 재계산은 10분 간격.
 *
 * 처음 한 번 아래 주소로 열면 연결 정보가 기기에 저장된다 (# 뒤는 서버로 전송되지 않음):
 *   index.html#gas=<Apps Script 웹앱 URL>&token=<TOKEN>
 * 옵션: ?demo=1 (예시 데이터로 보기)   #reset=1 (연결 정보 지우기)
 *
 * 전체화면: 브라우저는 사용자 조작 없이 전체화면을 허락하지 않으므로, 화면을 탭할 때 요청한다.
 * '홈 화면에 추가'로 열면 manifest 의 display: fullscreen 으로 처음부터 주소창 없이 열린다.
 */
(function () {
  'use strict';

  var DAYS = ['일', '월', '화', '수', '목', '금', '토'];
  var KEY_DATA = 'eink.data';
  var KEY_GAS = 'eink.gas';
  var SYNC_MIN = 30;
  var QUOTE_FIRST_HOUR = 7;   // 07시부터
  var QUOTE_LAST_HOUR = 17;   // 17시까지 매시 정각에 바뀐다
  var CAL_LINES = 7;       // 오늘 + 다가오는 일정 줄 수 합계 목표 (오늘이 많으면 다가오는 일정이 줄어든다)
  var UPCOMING_MAX = 5;    // 다가오는 일정 최대 줄 수

  var params = parseQuery(location.search.slice(1));
  var DEMO = params.demo === '1';
  var IN_APP = !!window.EinkApp;   // 전용 안드로이드 앱 안에서 열렸는지

  var data = null;          // 마지막으로 받은 데이터
  var sync = { state: 'idle', lastError: null };
  var lastRendered = {};
  var fitPending = {};

  // ---------- 유틸 ----------
  function $(id) { return document.getElementById(id); }

  function parseQuery(q) {
    var out = {};
    q.split('&').forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf('=');
      out[decodeURIComponent(i < 0 ? kv : kv.slice(0, i))] = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1));
    });
    return out;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function store(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* 저장 불가 환경은 무시 */ }
  }

  function load(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
  }

  // 날짜는 전부 서울 로컬 문자열로 다룬다: "2026-10-27", "2026-10-27T14:00"
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function ymdhm(d) { return ymd(d) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function toDate(s) {
    return new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +(s.slice(11, 13) || 0), +(s.slice(14, 16) || 0));
  }
  function addDays(s, n) { var d = toDate(s); d.setDate(d.getDate() + n); return ymd(d); }
  function md(s) { return +s.slice(5, 7) + '/' + +s.slice(8, 10); }
  // 다가오는 일정 날짜: MM/DD (요일) — 두 자리로 맞춰 세로 정렬
  function mmddDow(s) { return s.slice(5, 7) + '/' + s.slice(8, 10) + ' (' + DAYS[toDate(s).getDay()] + ')'; }
  function hm(s) { return s.slice(11, 16); }

  function setHtml(id, html) {
    var el = $(id);
    // HTML 과 스크립트 버전이 어긋나 칸이 없어도 멈추지 않고 나머지를 그린다
    if (!el || lastRendered[id] === html) return;
    lastRendered[id] = html;
    el.innerHTML = html;
    var pane = el.closest ? el.closest('.pane') : null;
    if (pane) scheduleFit(pane.id);
  }

  // ---------- 영역별 글자 맞춤 ----------
  // 각 영역(캘린더/인용구)이 넘치면 그 영역 글자만 조금씩 줄인다. 최소 60%.
  function scheduleFit(paneId) {
    if (fitPending[paneId]) return;
    fitPending[paneId] = true;
    setTimeout(function () { fitPending[paneId] = false; fit(paneId); }, 0);
  }

  function fit(paneId) {
    // 일정 칸은 글자 크기 고정 (줄 수 상한이 있어 넘치지 않는다). 글자 맞춤은 책갈피만
    if (paneId !== 'quote') return;
    var pane = $(paneId);
    var inner = $(paneId + '-fit');
    var scale = 1;
    inner.style.fontSize = '';
    while (pane.scrollHeight > pane.clientHeight + 1 && scale > 0.6) {
      scale -= 0.04;
      inner.style.fontSize = scale + 'em';
    }
  }

  // ---------- 일정 계산 ----------
  function eventsOn(day) {
    var dayStart = day + 'T00:00';
    var list = (data && data.events || []).filter(function (ev) {
      if (ev.all_day) return ev.start <= day && ev.end > day;   // 종일 일정 end 는 배타적
      return ev.start.slice(0, 10) === day || (ev.start < dayStart && ev.end > dayStart);
    });
    list.sort(function (a, b) {
      if (a.all_day !== b.all_day) return a.all_day ? -1 : 1;
      return a.start < b.start ? -1 : (a.start > b.start ? 1 : 0);
    });
    return list;
  }


  // ---------- 렌더 ----------
  function renderHeader(now) {
    setHtml('date', now.getFullYear() + '년 ' + (now.getMonth() + 1) + '월 ' + now.getDate() + '일 (' + DAYS[now.getDay()] + ')');
  }

  function renderCalendar(now) {
    var today = ymd(now);
    var nowStr = ymdhm(now);

    if (!data) {
      var msg = load(KEY_GAS) || DEMO ? '아직 동기화 전입니다' : '연동 정보가 없습니다 (README 참고)';
      setHtml('today', '<li class="empty">' + msg + '</li>'); setHtml('week', ''); setHtml('today-done', '');
      return;
    }

    // ── 오늘: 끝나지 않은 일정 (진행 중 표시), 지난 건 제목 줄에 건수만
    var todays = eventsOn(today);
    var remain = todays.filter(function (ev) { return ev.all_day || ev.end > nowStr; });
    var done = todays.length - remain.length;
    // 오늘 칸은 최대 CAL_LINES-1 줄. 넘치면 마지막 줄을 '외 N건' 으로
    var todayMax = CAL_LINES - 1;
    var todayShown = remain.length > todayMax ? remain.slice(0, todayMax - 1) : remain;
    var html = todayShown.map(function (ev) {
      var isNow = !ev.all_day && ev.start <= nowStr;
      return '<li><span class="t">' + (ev.all_day ? '종일' : hm(ev.start)) + '</span><span class="x">' +
        esc(ev.title) + '</span>' + (isNow ? '<span class="r">진행 중</span>' : '') + '</li>';
    }).join('');
    if (todayShown.length < remain.length) html += '<li class="empty">외 ' + (remain.length - todayShown.length) + '건</li>';
    setHtml('today-done', done > 0 ? '지난 일정 ' + done + '건' : '');
    setHtml('today', html || '<li class="empty">오늘 남은 일정 없음</li>');

    // 다가오는 일정 줄 수: 오늘 일정과 합쳐 CAL_LINES 줄 안에서, 최대 UPCOMING_MAX 줄 (최소 1줄)
    var todayLines = Math.max(1, Math.min(remain.length, todayMax));
    var upcomingMax = Math.max(1, Math.min(UPCOMING_MAX, CAL_LINES - todayLines));

    // ── 다가오는 일정: 내일부터 받아 둔 범위 끝까지 (최대 upcomingMax 줄)
    var lastDay = data.range_end ? addDays(data.range_end, -1) : addDays(today, 14);
    var lines = 0, more = 0, weekHtml = '', shown = todays.slice();   // 오늘 칸에 나온 일정은 빼고
    for (var d = addDays(today, 1); d <= lastDay; d = addDays(d, 1)) {
      // 여러 날에 걸친 일정은 처음 나오는 날에만 적는다
      var evs = eventsOn(d).filter(function (ev) { return shown.indexOf(ev) < 0; });
      evs.forEach(function (ev, i) {
        shown.push(ev);
        if (lines >= upcomingMax) { more++; return; }
        lines++;
        // 날짜는 그날 첫 일정에만 적는다
        weekHtml += '<li><span class="d">' + (i === 0 ? mmddDow(d) : '') + '</span><span class="t">' +
          (ev.all_day ? '종일' : hm(ev.start)) + '</span><span class="x">' + esc((ev.title)) + '</span></li>';
      });
    }
    weekHtml = weekHtml ? '<ul class="list">' + weekHtml + '</ul>' : '';
    if (more) weekHtml += '<div class="empty">외 ' + more + '건</div>';
    setHtml('week', weekHtml || '<div class="empty">없음</div>');
  }

  // ---------- 인용구 ----------
  // 07~17시 매시 정각에 하나씩 (슬롯 번호). 무작위 모드에선 섞되 한 바퀴 돌기 전엔 반복하지 않는다.
  function quoteSlot(now) {
    var h = now.getHours();
    var day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (h < QUOTE_FIRST_HOUR) { day.setDate(day.getDate() - 1); h = QUOTE_LAST_HOUR; }
    if (h > QUOTE_LAST_HOUR) h = QUOTE_LAST_HOUR;
    var days = Math.round((day - new Date(2026, 0, 1)) / 86400000);
    return days * (QUOTE_LAST_HOUR - QUOTE_FIRST_HOUR + 1) + (h - QUOTE_FIRST_HOUR);
  }

  // 인용구 묶음이 같으면 늘 같은 순서가 나오는 결정적 섞기
  var orderCache = { key: null, order: null };
  function quoteOrder(quotes) {
    var key = quotes.length + ':' + (data.quotes_updated_at || '');
    if (orderCache.key === key) return orderCache.order;
    var order = [];
    for (var i = 0; i < quotes.length; i++) order.push(i);
    var seed = 20261024;
    for (var j = order.length - 1; j > 0; j--) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      var k = seed % (j + 1);
      var t = order[j]; order[j] = order[k]; order[k] = t;
    }
    orderCache = { key: key, order: order };
    return order;
  }

  // ---------- 인용구 보기 방식 ----------
  // 'book'   : 책 순서. 노트 파일명(날짜)순으로 한 책의 인용구를 적힌 순서대로, 다 보면 다음 책.
  //            ↻ 는 다음 문장으로 넘기고, 그 자리에서 이어 간다(기기에 기억).
  // 'random' : 무작위. 섞인 순서로 매시 바뀌고, ↻ 는 아무 문장이나. 다음 정각엔 원래 순서로.
  var KEY_QUOTE_MODE = 'eink.quoteMode';
  var KEY_QUOTE_CURSOR = 'eink.quoteCursor';
  var quoteMode = load(KEY_QUOTE_MODE) === 'random' ? 'random' : 'book';
  var picked = { slot: null, index: null };   // 무작위 모드에서 ↻ 로 고른 것

  function bookCursor(slot) {
    var c = load(KEY_QUOTE_CURSOR);
    if (!c || typeof c.pos !== 'number' || typeof c.slot !== 'number') {
      c = { pos: 0, slot: slot };   // 처음엔 첫 책 첫 문장부터
      store(KEY_QUOTE_CURSOR, c);
    }
    return c;
  }

  function currentQuoteIndex(quotes, now) {
    var slot = quoteSlot(now);
    if (quoteMode === 'book') {
      var c = bookCursor(slot);
      var pos = c.pos + Math.max(0, slot - c.slot);   // 매시 정각마다 한 문장씩 앞으로
      return pos % quotes.length;
    }
    if (picked.slot === slot && picked.index < quotes.length) return picked.index;
    var order = quoteOrder(quotes);
    return order[slot % order.length];
  }

  function pickAnotherQuote() {
    var quotes = data && data.quotes || [];
    if (quotes.length < 2) return;
    var now = new Date();
    var slot = quoteSlot(now);
    if (quoteMode === 'book') {
      // 지금 보이는 문장 다음으로 커서를 옮긴다
      store(KEY_QUOTE_CURSOR, { pos: currentQuoteIndex(quotes, now) + 1, slot: slot });
    } else {
      var current = currentQuoteIndex(quotes, now);
      var next;
      do { next = Math.floor(Math.random() * quotes.length); } while (next === current);
      picked = { slot: slot, index: next };
    }
    renderQuote(now);
  }

  function toggleQuoteMode() {
    var quotes = data && data.quotes || [];
    var now = new Date();
    if (quoteMode === 'random') {
      // 책 순서로 바꾸면 지금 보이는 문장의 책에서부터 이어 간다
      var cur = quotes.length ? currentQuoteIndex(quotes, now) : 0;
      quoteMode = 'book';
      store(KEY_QUOTE_CURSOR, { pos: cur, slot: quoteSlot(now) });
    } else {
      quoteMode = 'random';
      picked = { slot: null, index: null };
    }
    store(KEY_QUOTE_MODE, quoteMode);
    renderQuote(now);
  }

  function renderQuote(now) {
    setHtml('quote-mode', quoteMode === 'book' ? '책 순서' : '무작위');
    var quotes = data && data.quotes || [];
    if (!quotes.length) {
      setHtml('quote-fit', '<p class="empty">' + (data ? '받아 둔 인용구가 없습니다 (옵시디언 플러그인에서 보내기 필요)' : '') + '</p>');
      return;
    }
    var q = quotes[currentQuoteIndex(quotes, now)];
    // 줄바꿈마다 문단으로 나눈다
    var paras = q.text.split('\n').filter(function (t) { return t.trim(); }).map(function (t) {
      return '<p class="q-text">' + esc(t).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\*\*/g, '') + '</p>';
    }).join('');
    var by = q.book + (q.author ? ', ' + q.author : '');
    setHtml('quote-fit', paras + '<p class="q-by">— ' + esc(by) + '</p>');
  }

  // ---------- 상태 줄 ----------
  function agoText(iso, now) {
    if (!iso) return '';
    var min = Math.round((now - toDate(iso.slice(0, 16))) / 60000);
    if (min < 60) return '방금';
    if (min < 60 * 24) return Math.floor(min / 60) + '시간 전';
    return Math.floor(min / 1440) + '일 전';
  }

  function renderStatus(now) {
    var s;
    if (sync.state === 'busy') s = '동기화 중…';
    else if (!data) s = sync.lastError ? '동기화 실패 (' + sync.lastError + ')' : '';
    else {
      var at = data.generated_at;
      s = '동기화 ' + md(at) + ' ' + at.slice(11, 16) + ' (' + agoText(at, now) + ')';
      if ((now - toDate(at.slice(0, 16))) > 24 * 3600000) s = '⚠ ' + s;
      if (sync.lastError) s += ' · 마지막 시도 실패';
    }
    setHtml('status', s || '&nbsp;');
  }

  function renderAll() {
    var now = new Date();
    renderHeader(now);
    renderCalendar(now);
    renderStatus(now);
    renderQuote(now);
  }

  // ---------- 동기화 ----------
  function getJson(url, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.timeout = 25000;
    xhr.onload = function () {
      if (xhr.status < 200 || xhr.status >= 300) return cb('HTTP ' + xhr.status);
      try { cb(null, JSON.parse(xhr.responseText)); } catch (e) { cb('응답 오류'); }
    };
    xhr.onerror = function () { cb('오프라인'); };
    xhr.ontimeout = function () { cb('시간 초과'); };
    xhr.send();
  }

  function syncNow() {
    if (sync.state === 'busy') return;
    var url;
    if (DEMO) url = 'data/demo.json?t=' + Date.now();
    else {
      var gas = load(KEY_GAS);
      if (!gas || !gas.url) { renderAll(); return; }
      url = gas.url + (gas.url.indexOf('?') < 0 ? '?' : '&') + 'token=' + encodeURIComponent(gas.token);
    }
    sync.state = 'busy';
    renderStatus(new Date());
    getJson(url, function (err, res) {
      sync.state = 'idle';
      if (!err && res && res.error) err = res.error;
      if (err) {
        sync.lastError = err;
      } else {
        sync.lastError = null;
        data = DEMO ? demoToData(res) : res;
        if (!DEMO) store(KEY_DATA, data);
      }
      renderAll();
    });
  }

  // 예시 데이터는 '오늘로부터 며칠 뒤' 형태라 실제 날짜로 바꿔 준다
  function demoToData(demo) {
    var now = new Date(), today = ymd(now);
    function conv(ev) {
      var d = addDays(today, ev.day);
      return ev.all_day
        ? { title: ev.title, all_day: true, start: d, end: addDays(d, ev.days || 1) }
        : { title: ev.title, all_day: false, start: d + 'T' + ev.start, end: d + 'T' + ev.end };
    }
    return {
      generated_at: ymdhm(now) + ':00+09:00',
      range_end: addDays(today, 15),
      events: demo.events.map(conv),
      quotes_updated_at: 'demo',
      quotes: demo.quotes
    };
  }

  // ---------- 시작 ----------
  function captureConfigFromHash() {
    var h = parseQuery(location.hash.slice(1));
    var clear = false;
    if (h.gas && h.token) { store(KEY_GAS, { url: h.gas, token: h.token }); clear = true; }
    if (h.reset === '1') {
      try { localStorage.removeItem(KEY_GAS); localStorage.removeItem(KEY_DATA); } catch (e) { /* 무시 */ }
      clear = true;
    }
    // 토큰이 주소창·방문 기록에 남지 않게 지운다
    if (clear && history.replaceState) history.replaceState(null, '', location.pathname + location.search);
  }

  // 화면은 10분마다만 다시 계산한다: 끝난 일정 걸러내기, 다음 일정 넘기기, 진행 중 표시, 정각 인용구 교체.
  // 내용이 바뀐 영역만 다시 그리므로 실제로 전자잉크가 갱신되는 일은 더 드물다.
  var RENDER_EVERY_MS = 10 * 60000;
  function everyTenMinutes() {
    renderAll();
    setTimeout(everyTenMinutes, RENDER_EVERY_MS - (Date.now() % RENDER_EVERY_MS) + 50);
  }

  captureConfigFromHash();
  if (!DEMO) data = load(KEY_DATA);
  everyTenMinutes();
  syncNow();
  setInterval(syncNow, SYNC_MIN * 60000);
  window.addEventListener('online', function () { setTimeout(syncNow, 3000); });
  document.addEventListener('click', function () { if (!IN_APP) enterFullscreen(); syncNow(); });
  // 책갈피 ↻: 다른 인용구 보기 (동기화는 하지 않는다)
  var nextBtn = $('quote-next');
  if (nextBtn) nextBtn.addEventListener('click', function (e) { e.stopPropagation(); pickAnotherQuote(); });
  // 책갈피 보기 방식 전환: 책 순서 ↔ 무작위
  var modeBtn = $('quote-mode');
  if (modeBtn) modeBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleQuoteMode(); });
  // 앱의 '연결 설정'은 같은 페이지에 #gas=... 만 바꿔 넘긴다 → 새로고침 없이 받아 저장
  window.addEventListener('hashchange', function () {
    captureConfigFromHash();
    if (!DEMO) data = load(KEY_DATA);
    syncNow();
  });
  // 앱 메뉴의 '지금 동기화'
  window.einkSync = syncNow;
  // 전체화면 전환 등으로 화면 높이가 바뀌면 글자 맞춤을 다시 한다
  window.addEventListener('resize', function () { scheduleFit('cal'); scheduleFit('quote'); });

  function enterFullscreen() {
    var el = document.documentElement;
    if (document.fullscreenElement || document.webkitFullscreenElement) return;
    var req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req) return;
    try {
      var p = req.call(el);
      if (p && p['catch']) p['catch'](function () { /* 거부돼도 그냥 둔다 */ });
    } catch (e) { /* 지원 안 하는 브라우저 */ }
  }

  // 페이지 파일을 기기에 저장해 두는 서비스 워커 (오프라인에서 브라우저가 다시 열려도 화면이 뜨게)
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js')['catch'](function () { /* 실패해도 페이지는 동작 */ });
  }
})();
