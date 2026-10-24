/**
 * 업무 캘린더 + 독서 인용구 → Poke3 대시보드 중계 (Google Apps Script 웹앱)
 *
 * GET  ?token=...   대시보드가 호출. 업무 일정 + 인용구를 한 번에 돌려준다.
 * POST {token, bundle}  옵시디언 플러그인(obsidian_plugin/)이 호출. Books 폴더 노트를 묶어 보낸다.
 *                       인용구만 뽑아 스크립트 속성에 압축해 저장한다 (드라이브 권한 불필요).
 *
 * - 업무 캘린더는 지정한 하나만 읽는다. 기본 캘린더로 대신 넘어가지 않는다(개인 일정 노출 방지).
 * - 일정은 제목·시간만 보낸다. 장소·설명·참석자는 보내지 않는다.
 * - 토큰이 맞을 때만 응답한다. 내용은 기기 localStorage 에만 남고 공개 레포에는 올라가지 않는다.
 *
 * 스크립트 속성 (프로젝트 설정 → 스크립트 속성):
 *   TOKEN           필수. setupToken() 을 실행하면 만들어진다
 *   CALENDAR_NAME   업무 캘린더 이름 (예: 업무)          ┐ 둘 중 하나 필수
 *   CALENDAR_ID     업무 캘린더 ID (listCalendars() 로 확인) ┘ ID 가 있으면 ID 우선
 *   DAYS_AHEAD      선택. 일반 일정을 며칠 앞까지 받을지. 기본 14
 *   DEADLINE_DAYS   선택. [마감]/[D] 일정을 며칠 앞까지 받을지. 기본 60
 *   QUOTE_MAX_CHARS 선택. 이보다 긴 인용구는 건너뛴다. 기본 300
 *   QUOTES_N, QUOTES_0.. 자동. 압축한 인용구 조각 (직접 고치지 말 것)
 */

var DEADLINE_RE = /\[(마감|D)\]/;

function doGet(e) {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('TOKEN');
  if (!token || !e || !e.parameter || e.parameter.token !== token) {
    return json_({ error: 'unauthorized' });
  }
  try {
    return json_(buildPayload_(props));
  } catch (err) {
    return json_({ error: String(err && err.message || err) });
  }
}

function buildPayload_(props) {
  var tz = Session.getScriptTimeZone();
  var cal = workCalendar_(props);
  var now = new Date();
  var start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var daysAhead = Number(props.getProperty('DAYS_AHEAD')) || 14;
  var deadlineDays = Number(props.getProperty('DEADLINE_DAYS')) || 60;
  var end = addDays_(start, daysAhead + 1);

  var events = cal.getEvents(start, end).map(function (ev) { return toItem_(ev, tz); });

  // D-day 는 더 멀리까지 본다. 제목에 [마감] 또는 [D] 가 있는 일정만.
  var deadlines = cal.getEvents(start, addDays_(start, deadlineDays + 1))
    .filter(function (ev) { return DEADLINE_RE.test(ev.getTitle()); })
    .map(function (ev) { return toItem_(ev, tz); });

  var q = loadQuotes_(props);
  return {
    generated_at: Utilities.formatDate(now, tz, "yyyy-MM-dd'T'HH:mm:ssXXX"),
    range_end: Utilities.formatDate(end, tz, 'yyyy-MM-dd'),
    events: events,
    deadlines: deadlines,
    quotes_updated_at: q.updated_at,
    quotes: q.quotes
  };
}

/**
 * 시각은 서울 기준 로컬 문자열("2026-10-27T14:00")로 보낸다 — 기기는 문자열 비교만 한다.
 * 종일 일정의 end 는 구글 방식대로 '끝난 다음 날'(배타적)이다.
 */
function toItem_(ev, tz) {
  var allDay = ev.isAllDayEvent();
  var fmt = allDay ? 'yyyy-MM-dd' : "yyyy-MM-dd'T'HH:mm";
  return {
    title: ev.getTitle(),
    all_day: allDay,
    start: Utilities.formatDate(allDay ? ev.getAllDayStartDate() : ev.getStartTime(), tz, fmt),
    end: Utilities.formatDate(allDay ? ev.getAllDayEndDate() : ev.getEndTime(), tz, fmt)
  };
}

function workCalendar_(props) {
  var id = props.getProperty('CALENDAR_ID');
  var name = props.getProperty('CALENDAR_NAME');
  var cal = null;
  if (id) cal = CalendarApp.getCalendarById(id);
  else if (name) cal = CalendarApp.getCalendarsByName(name)[0] || null;
  if (!cal) throw new Error('work calendar not found (check CALENDAR_ID / CALENDAR_NAME)');
  return cal;
}

function addDays_(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

// ---------- 인용구 (옵시디언 플러그인 → doPost) ----------

var FILE_MARK = /^@@@FILE@@@ ?(.*)$/;

function doPost(e) {
  var props = PropertiesService.getScriptProperties();
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ error: 'bad json' }); }
  var token = props.getProperty('TOKEN');
  if (!token || body.token !== token) return json_({ error: 'unauthorized' });
  if (!body.bundle) return json_({ error: 'empty bundle' });

  var maxChars = Number(props.getProperty('QUOTE_MAX_CHARS')) || 300;
  var files = splitBundle_(String(body.bundle));
  var quotes = [];
  var skipped = 0;
  files.forEach(function (f) {
    var book = parseBookName_(f.name);
    extractQuotes_(f.text).forEach(function (text) {
      if (plainLength_(text) > maxChars) { skipped++; return; }
      quotes.push({ text: text, book: book.title, author: book.author });
    });
  });
  // 파일이 하나도 안 왔거나 인용구가 0개면 기존 저장분을 지우지 않는다 (전송 오작동 대비)
  if (!quotes.length) return json_({ error: 'no quotes found', files: files.length });

  var tz = Session.getScriptTimeZone();
  try {
    saveQuotes_(props, {
      updated_at: Utilities.formatDate(new Date(), tz, "yyyy-MM-dd'T'HH:mm:ssXXX"),
      quotes: quotes
    });
  } catch (err) {
    // 저장 실패도 JSON 으로 돌려줘야 플러그인 화면에 이유가 보인다
    return json_({ error: 'save failed: ' + (err && err.message || err), quotes: quotes.length });
  }
  return json_({ ok: true, files: files.length, quotes: quotes.length, skipped_long: skipped });
}

/** "@@@FILE@@@ 파일명" 줄로 구분된 묶음을 [{name, text}] 로 나눈다 */
function splitBundle_(bundle) {
  var out = [];
  var cur = null;
  bundle.replace(/\r\n?/g, '\n').split('\n').forEach(function (line) {
    var m = line.match(FILE_MARK);
    if (m) { cur = { name: m[1].trim(), lines: [] }; out.push(cur); return; }
    if (cur) cur.lines.push(line);
  });
  return out.map(function (f) { return { name: f.name, text: f.lines.join('\n') }; });
}

/** "2026-07-13 ● (독서) 죽도록 즐기기, 닐 포스트먼.md" → {title: 죽도록 즐기기, author: 닐 포스트먼} */
function parseBookName_(name) {
  var s = name.replace(/\.md$/i, '')
    .replace(/^\d{4}-\d{2}-\d{2}\s*/, '')
    .replace(/^[●•·\-\s]+/, '')
    .replace(/^\(독서\)\s*/, '')
    .trim();
  var i = s.lastIndexOf(',');
  if (i < 0) return { title: s, author: '' };
  return { title: s.slice(0, i).trim(), author: s.slice(i + 1).trim() };
}

/**
 * 노트에서 인용 블록(>)만 뽑는다.
 * - 빈 줄로 끊긴 인용 블록 하나 = 인용구 하나
 * - 콜아웃(> [!생각] 등)은 직접 쓴 메모이므로 제외
 * - 강조는 **굵게** 로 통일한다 (==형광펜== 포함). 그 밖의 마크다운은 걷어낸다
 */
function extractQuotes_(md) {
  var lines = md.replace(/\r\n?/g, '\n').split('\n');
  // 프론트매터 건너뛰기
  if (lines[0] === '---') {
    var end = lines.indexOf('---', 1);
    if (end > 0) lines = lines.slice(end + 1);
  }
  var blocks = [];
  var cur = null;
  lines.forEach(function (line) {
    var m = line.match(/^\s*>\s?(.*)$/);
    if (!m) { cur = null; return; }
    if (!cur) { cur = []; blocks.push(cur); }
    cur.push(m[1]);
  });

  var out = [];
  blocks.forEach(function (b) {
    if (/^\s*\[!/.test(b[0])) return;  // 콜아웃
    var text = b.map(function (l) { return l.trim(); })
      .join('\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
    text = cleanMarkdown_(text);
    if (plainLength_(text) >= 10) out.push(text);
  });
  return out;
}

function cleanMarkdown_(s) {
  return s
    .replace(/!\[\[[^\]]*\]\]/g, '')                          // 내장 이미지
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')           // [[링크|별칭]] → 별칭
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')                  // [글](주소) → 글
    .replace(/==([^=]+)==/g, '**$1**')                        // 형광펜 → 강조
    .replace(/__([^_]+)__/g, '**$1**')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')          // *기울임* → 그냥 글자
    .replace(/`([^`]*)`/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*\s*\*\*/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function plainLength_(s) {
  return s.replace(/\*\*/g, '').replace(/\s+/g, ' ').length;
}

/*
 * 인용구 저장소: 스크립트 속성에 gzip + base64 로 압축해 조각내어 넣는다.
 * 속성 하나는 9KB, 전체 500KB 까지라 8000자씩 나눈다. 한국어 글은 압축이 잘 돼 인용구 수천 개가 들어간다.
 */
var QUOTE_CHUNK = 8000;

function loadQuotes_(props) {
  var n = Number(props.getProperty('QUOTES_N')) || 0;
  if (!n) return { updated_at: null, quotes: [] };
  try {
    var b64 = '';
    for (var i = 0; i < n; i++) b64 += props.getProperty('QUOTES_' + i) || '';
    var gz = Utilities.newBlob(Utilities.base64Decode(b64), 'application/x-gzip');
    return JSON.parse(Utilities.ungzip(gz).getDataAsString('UTF-8'));
  } catch (err) {
    return { updated_at: null, quotes: [], error: String(err) };
  }
}

function saveQuotes_(props, data) {
  var blob = Utilities.newBlob(JSON.stringify(data), 'application/json', 'quotes.json');
  var b64 = Utilities.base64Encode(Utilities.gzip(blob).getBytes());
  var chunks = {};
  var n = Math.ceil(b64.length / QUOTE_CHUNK);
  for (var i = 0; i < n; i++) chunks['QUOTES_' + i] = b64.slice(i * QUOTE_CHUNK, (i + 1) * QUOTE_CHUNK);
  chunks.QUOTES_N = String(n);
  // 예전 조각이 더 많았으면 남은 것을 지운다
  var old = Number(props.getProperty('QUOTES_N')) || 0;
  props.setProperties(chunks);
  for (var k = n; k < old; k++) props.deleteProperty('QUOTES_' + k);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------- 편집기에서 직접 실행하는 도우미 ----------

/** TOKEN 이 없으면 새로 만들어 저장하고 로그에 보여준다. */
function setupToken() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('TOKEN');
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('TOKEN', token);
  }
  Logger.log('TOKEN = ' + token);
}

/** 내 캘린더 이름·ID 목록 (CALENDAR_NAME / CALENDAR_ID 를 고를 때) */
function listCalendars() {
  CalendarApp.getAllCalendars().forEach(function (c) {
    Logger.log(c.getName() + '  |  ' + c.getId());
  });
}

/** 권한 승인 + 실제로 넘어갈 내용 확인 */
function debugPayload() {
  Logger.log(JSON.stringify(buildPayload_(PropertiesService.getScriptProperties()), null, 2));
}

/** 인용구 추출 시험: 아래 SAMPLE 에 노트 내용을 붙여 넣고 실행 */
function debugExtract() {
  var SAMPLE = '> 첫 번째 인용구입니다. **강조 부분**도 있습니다.\n\n> [!생각]\n> 이건 메모라 빠져야 합니다.';
  Logger.log(JSON.stringify(extractQuotes_(SAMPLE), null, 2));
}
