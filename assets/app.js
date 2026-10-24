/*
 * 업무 캘린더 + 독서 인용구 전자잉크 대시보드
 *
 * 구형 안드로이드 웹뷰를 고려해 ES5 로만 작성한다 (화살표 함수·let·옵셔널 체이닝 금지).
 *
 * - 데이터는 Apps Script 웹앱에서 한 번에 받는다 (일정 2주치 + 인용구 전체).
 *   네트워크는 핫스팟을 켤 때만 있다고 가정하고, 받은 데이터는 localStorage 에 둔다.
 *   '오늘', '다음 일정까지 남은 시간', '지금 인용구'는 전부 기기 시계로 계산한다.
 * - 동기화 시점: 페이지 열 때, 네트워크가 연결되는 순간(online), 화면을 탭할 때, 30분마다.
 * - 잔상 줄이기: 내용이 바뀐 영역만 다시 그린다. 남은 시간은 10분 단위로만 바뀐다.
 *
 * 처음 한 번 아래 주소로 열면 연결 정보가 기기에 저장된다 (# 뒤는 서버로 전송되지 않음):
 *   index.html#gas=<Apps Script 웹앱 URL>&token=<TOKEN>
 * 옵션: ?demo=1 (예시 데이터로 보기)   ?clock=0 (시계 숨김)   #reset=1 (연결 정보 지우기)
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
  var DEADLINE_TAG = /\s*\[(마감|D)\]\s*/;
  var WEEK_MAX_LINES = 6;

  var params = parseQuery(location.search.slice(1));
  var DEMO = params.demo === '1';
  var SHOW_CLOCK = params.clock !== '0';

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
  function dayDiff(a, b) { return Math.round((toDate(b) - toDate(a)) / 86400000); }
  function md(s) { return +s.slice(5, 7) + '/' + +s.slice(8, 10); }
  function mdDow(s) { return md(s) + ' (' + DAYS[toDate(s).getDay()] + ')'; }
  function hm(s) { return s.slice(11, 16); }

  function setHtml(id, html) {
    if (lastRendered[id] === html) return;
    lastRendered[id] = html;
    $(id).innerHTML = html;
    var pane = $(id).closest ? $(id).closest('.pane') : null;
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

  function untilText(fromStr, toStr) {
    var min = Math.round((toDate(toStr) - toDate(fromStr)) / 60000);
    if (min < 10) return '곧 시작';
    min = Math.floor(min / 10) * 10;   // 10분 단위로만 바꿔 잔상을 줄인다
    var h = Math.floor(min / 60), m = min % 60;
    return (h ? h + '시간' + (m ? ' ' : '') : '') + (m ? m + '분' : '') + ' 후';
  }

  function cleanTitle(t) { return t.replace(new RegExp(DEADLINE_TAG.source, 'g'), ' ').trim(); }

  // ---------- 렌더 ----------
  function renderHeader(now) {
    setHtml('date', (now.getMonth() + 1) + '월 ' + now.getDate() + '일 (' + DAYS[now.getDay()] + ')');
    setHtml('clock', SHOW_CLOCK ? pad(now.getHours()) + ':' + pad(now.getMinutes()) : '');
  }

  function renderCalendar(now) {
    var today = ymd(now);
    var nowStr = ymdhm(now);

    if (!data) {
      var msg = load(KEY_GAS) || DEMO ? '아직 동기화 전입니다' : '연동 정보가 없습니다 (README 참고)';
      setHtml('hero', '<div class="hero-label">' + msg + '</div>');
      setHtml('today', ''); setHtml('week', ''); setHtml('dday', '');
      return;
    }

    var todays = eventsOn(today);
    var timed = todays.filter(function (ev) { return !ev.all_day; });
    var ongoing = timed.filter(function (ev) { return ev.start <= nowStr && ev.end > nowStr; });
    var next = timed.filter(function (ev) { return ev.start > nowStr; })[0] || null;

    // ── 다음 일정 강조 상자
    var hero;
    if (next) {
      hero = '<div class="hero-label">다음 일정 · ' + untilText(nowStr, next.start) + '</div>' +
        '<div class="hero-main"><span class="t">' + hm(next.start) + '</span>' + esc(cleanTitle(next.title)) + '</div>';
    } else if (ongoing.length) {
      hero = '<div class="hero-label">진행 중 · ' + hm(ongoing[0].end) + ' 종료</div>' +
        '<div class="hero-main">' + esc(cleanTitle(ongoing[0].title)) + '</div>';
    } else {
      // 오늘 남은 일정이 없으면 받아 둔 범위 안에서 가장 가까운 일정
      var later = (data.events || []).filter(function (ev) {
        return ev.all_day ? ev.start > today : ev.start.slice(0, 10) > today;
      }).sort(function (a, b) { return a.start < b.start ? -1 : 1; })[0];
      hero = later
        ? '<div class="hero-label">오늘 남은 일정 없음 · 다음은 ' + mdDow(later.start.slice(0, 10)) + '</div>' +
          '<div class="hero-main">' + (later.all_day ? '' : '<span class="t">' + hm(later.start) + '</span>') + esc(cleanTitle(later.title)) + '</div>'
        : '<div class="hero-label">예정된 일정 없음</div>';
    }
    setHtml('hero', hero);

    // ── 오늘: 끝나지 않은 일정만 (강조 상자에 나온 다음 일정은 빼고), 지난 건 건수만
    var remain = todays.filter(function (ev) { return ev.all_day || ev.end > nowStr; })
      .filter(function (ev) { return ev !== next; });
    var done = todays.length - remain.length - (next ? 1 : 0);
    var html = remain.map(function (ev) {
      var isNow = !ev.all_day && ev.start <= nowStr;
      return '<li><span class="t">' + (ev.all_day ? '종일' : hm(ev.start)) + '</span><span class="x">' +
        esc(cleanTitle(ev.title)) + '</span>' + (isNow ? '<span class="r">진행 중</span>' : '') + '</li>';
    }).join('');
    setHtml('today-done', done > 0 ? '지난 일정 ' + done + '건' : '');
    setHtml('today', html || '<li class="empty">' + (next ? '이후 일정 없음' : '없음') + '</li>');

    // ── 이번 주 (금·토·일에는 다음 주 일요일까지)
    var dow = now.getDay();
    var toSunday = dow === 0 ? 7 : 7 - dow;
    var isLate = dow === 5 || dow === 6 || dow === 0;
    var lastDay = addDays(today, isLate ? toSunday + (dow === 0 ? 0 : 7) : toSunday);
    setHtml('week-title', isLate ? '다음 주' : '이번 주');
    var lines = 0, more = 0, weekHtml = '';
    for (var d = addDays(today, 1); d <= lastDay; d = addDays(d, 1)) {
      var evs = eventsOn(d).filter(function (ev) { return !DEADLINE_TAG.test(ev.title); });
      evs.forEach(function (ev, i) {
        if (lines >= WEEK_MAX_LINES) { more++; return; }
        lines++;
        // 날짜는 그날 첫 일정에만 적는다
        weekHtml += '<li><span class="d">' + (i === 0 ? mdDow(d) : '') + '</span><span class="t">' +
          (ev.all_day ? '종일' : hm(ev.start)) + '</span><span class="x">' + esc(cleanTitle(ev.title)) + '</span></li>';
      });
    }
    weekHtml = weekHtml ? '<ul class="list">' + weekHtml + '</ul>' : '';
    if (more) weekHtml += '<div class="empty">외 ' + more + '건</div>';
    if (data.range_end && lastDay >= data.range_end) weekHtml += '<div class="empty">※ ' + md(data.range_end) + ' 이후는 아직 받지 않음</div>';
    setHtml('week', weekHtml || '<div class="empty">없음</div>');

    // ── 마감 D-day (제목에 [마감] 또는 [D])
    var dd = (data.deadlines || []).map(function (ev) {
      var due = ev.all_day ? addDays(ev.end, -1) : ev.start.slice(0, 10);
      return { title: cleanTitle(ev.title), due: due, n: dayDiff(today, due) };
    }).filter(function (x) { return x.n >= 0; })
      .sort(function (a, b) { return a.n - b.n; })
      .slice(0, 4);
    $('dday-section').style.display = dd.length ? '' : 'none';
    setHtml('dday', dd.map(function (x) {
      return '<li><span class="t">' + (x.n === 0 ? 'D-DAY' : 'D-' + x.n) + '</span><span class="x">' + esc(x.title) +
        '</span><span class="r">' + mdDow(x.due) + '</span></li>';
    }).join(''));
  }

  // ---------- 인용구 ----------
  // 07~17시 매시 정각에 하나씩. 순서는 섞되 한 바퀴 돌기 전엔 반복하지 않는다.
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

  function renderQuote(now) {
    var quotes = data && data.quotes || [];
    if (!quotes.length) {
      setHtml('quote-fit', '<p class="empty">' + (data ? '받아 둔 인용구가 없습니다 (아이폰 단축어 실행 필요)' : '') + '</p>');
      return;
    }
    var order = quoteOrder(quotes);
    var q = quotes[order[quoteSlot(now) % order.length]];
    var text = esc(q.text).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\*\*/g, '');
    var by = q.book + (q.author ? ', ' + q.author : '');
    setHtml('quote-fit', '<p class="q-text">' + text + '</p><p class="q-by">— ' + esc(by) + '</p>');
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
    setHtml('status', (s ? s + ' · ' : '') + '화면을 누르면 동기화');
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
      deadlines: demo.deadlines.map(conv),
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

  function everyMinute() {
    renderAll();
    setTimeout(everyMinute, 60000 - (Date.now() % 60000) + 50);
  }

  captureConfigFromHash();
  if (!DEMO) data = load(KEY_DATA);
  everyMinute();
  syncNow();
  setInterval(syncNow, SYNC_MIN * 60000);
  window.addEventListener('online', function () { setTimeout(syncNow, 3000); });
  document.addEventListener('click', function () { enterFullscreen(); syncNow(); });
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
