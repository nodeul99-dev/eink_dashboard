package dev.nodeul99.eink;

import android.app.Activity;
import android.app.AlarmManager;
import android.app.AlertDialog;
import android.app.PendingIntent;
import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Point;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.Process;
import android.provider.Settings;
import android.text.InputType;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Date;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Poke3 대시보드 전용 홈 앱.
 *
 * 화면은 GitHub Pages 의 웹페이지를 그대로 띄우고, 이 앱은 기기 제어만 맡는다.
 * - 상태바·내비게이션 바를 숨긴 전체 화면, 화면 꺼짐 방지
 * - 홈 앱(런처)으로 등록 → 전원을 켜거나 홈 버튼을 눌러도 대시보드
 * - 화면 어디든 길게 누르면 관리 메뉴 (와이파이, 연결 설정, 잔상 지우기 등)
 * - USB 로 Download 폴더에 넣은 dashboard.txt 에서 연결 정보(웹앱 주소·토큰)를 읽는다
 * - 전자책처럼 잠든다: 만진 뒤 1분이면 화면이 꺼지고(BOOX 투명 화면보호기라 대시보드가 그대로 남는다),
 *   페이지가 알려 준 '다음에 화면이 바뀔 시각'(책갈피 교체·자정)에 잠깐 깨워 다시 그린다.
 *   Poke3 는 깊이 잠든 동안 앱 알람을 받지 않는다(2026-10-25 확인). 그래서 다음 깨울 시각이 가까우면(3시간 안,
 *   = 낮 07~18시) 화면만 끄고 프로세서는 붙잡아 둔 채(PARTIAL_WAKE_LOCK) 앱 타이머로 화면을 켠다.
 *   밤처럼 멀면 놓아 줘서 완전히 잠든다 (아침에 사람이 깨우면 그날 낮 동작이 다시 시작된다).
 *   알람도 함께 걸어 둔다 (울리면 좋고, 안 울려도 타이머가 있다).
 *   깨웠을 때만 화면 꺼짐 시간을 10초로 줄이고, 사람이 만지면 1분으로 되돌린다
 * - 깨어날 때 웹뷰가 액정보다 크게 잡히는 BOOX 문제: 크기를 재서 어긋나면 웹뷰를 새로 만들고,
 *   그래도 안 되면 앱 프로세스를 다시 시작한다 (메뉴 '화면 정보'에 측정값과 복구 기록)
 * - 매일 새벽 페이지를 다시 불러 레포에 푸시한 화면 변경을 반영
 */
public class MainActivity extends Activity {

    private static final String DASHBOARD_URL = "https://nodeul99-dev.github.io/eink_dashboard/";
    private static final int DAILY_RELOAD_HOUR = 4;
    private static final long CHECK_INTERVAL_MS = 30 * 60 * 1000L;
    private static final int REQ_READ_STORAGE = 1;
    private static final int REQ_PICK_FILE = 2;
    // 윈도우에서 확장자가 숨겨져 있으면 dashboard.txt.txt 로 저장되기 쉽다
    private static final String[] CONNECTION_FILES = {"dashboard.txt", "dashboard.txt.txt", "dashboard"};
    private static final Pattern EXEC_URL = Pattern.compile("https://script\\.google\\.com/macros/s/[A-Za-z0-9_\\-]+/exec");
    private static final Pattern TOKEN_PARAM = Pattern.compile("[?&]token=(?:\\s|%20)*([A-Za-z0-9_\\-]+)");
    private static final Pattern TOKEN_LINE = Pattern.compile("^\\s*([A-Za-z0-9_\\-]{20,})\\s*$", Pattern.MULTILINE);

    // 화면 꺼짐 시간: 평소(사람이 만진 뒤) 1분, 알람으로 깨워 다시 그릴 때는 10초 (안드로이드 최소값)
    static final int SCREEN_TIMEOUT_NORMAL = 60 * 1000;
    static final int SCREEN_TIMEOUT_ALARM = 10 * 1000;
    // 알람으로 깬 뒤 이 시간 안에 화면이 켜지면 '알람으로 깼다'고 본다
    private static final long ALARM_WAKE_WINDOW_MS = 30 * 1000L;
    // 화면 크기 확인: 깨어난 뒤 잠시 기다렸다 잰다. 어긋남 허용치 3%
    private static final long VIEWPORT_CHECK_DELAY_MS = 2500;
    private static final double VIEWPORT_TOLERANCE = 0.03;
    // 프로세스 재시작은 3분에 한 번까지 (그래도 안 되면 포기하고 재부팅 안내 — 무한 재시작 방지)
    private static final long RESTART_GUARD_MS = 3 * 60 * 1000L;

    private FrameLayout root;
    private WebView webView;
    private View flashOverlay;
    private SharedPreferences prefs;
    private PowerManager.WakeLock recoverLock;
    // 다음 깨울 시각이 이만큼 안이면 DayService 로 프로세서를 붙잡고 기다린다 (책갈피 간격은 최대 1시간, 밤엔 7시간 넘게 남는다)
    private static final long DAY_HOLD_MAX_MS = 3 * 60 * 60 * 1000L;
    private static final long TEST_DELAY_MS = 3 * 60 * 1000L;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private int lastReloadDay = -1;
    private int recoverStage = 0;      // 0: 정상, 1: 웹뷰를 새로 만듦 → 다시 쟀는데도 어긋나면 프로세스 재시작
    private String lastViewport = "";  // 메뉴 '화면 정보'에 보여 줄 마지막 측정값
    private AlertDialog openDialog;    // 떠 있는 관리 창 (잠들기 전에 닫는다)
    // 잠들기 직전에 열린 창을 닫는다: 투명 화면보호기는 꺼지는 순간의 화면을 그대로 남기므로
    // 창이 떠 있으면 잠든 내내 대시보드를 가린다. 화면 꺼짐(1분)보다 8초 먼저
    private static final long TIDY_BEFORE_SLEEP_MS = SCREEN_TIMEOUT_NORMAL - 8 * 1000L;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("eink", MODE_PRIVATE);
        // 혹시 잠금 화면이 뜨더라도 그 위에 대시보드를 띄운다
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.WHITE);

        webView = new WebView(this);
        setupWebView(webView);
        root.addView(webView, 0, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // 잔상 지우기용 검은 덮개 (평소엔 숨김)
        flashOverlay = new View(this);
        flashOverlay.setBackgroundColor(Color.BLACK);
        flashOverlay.setVisibility(View.GONE);
        root.addView(flashOverlay, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);
        hideSystemBars();

        webView.loadUrl(DASHBOARD_URL);
        // 화면 크기 복구로 방금 다시 시작했으면, 페이지가 다 그려지기 전에 잠들지 않게 잠깐 붙잡는다
        if (System.currentTimeMillis() - prefs.getLong("restart_at", 0) < 30 * 1000L) holdScreenForRecovery();
        lastReloadDay = Calendar.getInstance().get(Calendar.DAY_OF_YEAR);
        handler.postDelayed(dailyReload, CHECK_INTERVAL_MS);
    }

    private void setupWebView(WebView wv) {
        WebSettings s = wv.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);       // localStorage: 받아 둔 일정·인용구 보관
        s.setDatabaseEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setTextZoom(100);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(true);

        wv.setBackgroundColor(Color.WHITE);
        wv.setVerticalScrollBarEnabled(false);
        wv.setHorizontalScrollBarEnabled(false);
        wv.setOverScrollMode(View.OVER_SCROLL_NEVER);
        wv.setHapticFeedbackEnabled(false);

        // 페이지가 "앱 안에서 열렸는지" 알 수 있게 (안내 문구를 바꾸는 데 쓴다)
        wv.addJavascriptInterface(new Bridge(), "EinkApp");

        // 길게 누르면 관리 메뉴. true 를 돌려 글자 선택도 막는다.
        wv.setLongClickable(true);
        wv.setOnLongClickListener(v -> {
            showMenu();
            return true;
        });

        wv.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // 대시보드 밖으로는 나가지 않는다
                return !request.getUrl().toString().startsWith(DASHBOARD_URL);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                // 한 번도 연결된 적 없이 오프라인으로 켜졌을 때만 여기로 온다
                // (한 번 열린 뒤에는 서비스 워커가 저장본을 보여준다)
                if (request.isForMainFrame()) {
                    view.loadDataWithBaseURL(null, offlineHtml(), "text/html", "utf-8", null);
                }
            }
        });
    }

    private String offlineHtml() {
        return "<html><body style='font-family:sans-serif;padding:2em;font-size:20px;background:#fff;color:#000'>"
                + "<h2>연결이 필요합니다</h2>"
                + "<p>처음 한 번은 인터넷에 연결된 상태에서 열어야 합니다.</p>"
                + "<p>와이파이(핫스팟)에 연결한 뒤 화면을 <b>길게 눌러</b> '다시 불러오기'를 고르세요.</p>"
                + "</body></html>";
    }

    // ---------- 관리 메뉴 ----------

    /** 관리 창을 띄우고 기억해 둔다 (잠들기 전에 닫을 수 있게) */
    private void showDialog(AlertDialog d) {
        openDialog = d;
        d.show();
        scheduleTidy();
    }

    private final Runnable tidy = this::closeOverlays;

    private void scheduleTidy() {
        handler.removeCallbacks(tidy);
        handler.postDelayed(tidy, TIDY_BEFORE_SLEEP_MS);
    }

    /** 열린 창(관리 메뉴·화면 정보·책갈피 ⚙ 설정)을 닫는다 */
    private void closeOverlays() {
        if (openDialog != null && openDialog.isShowing()) openDialog.dismiss();
        openDialog = null;
        webView.evaluateJavascript("window.einkCloseOverlays && window.einkCloseOverlays()", null);
    }

    private void showMenu() {
        final String[] items = {
                "지금 동기화",
                "화면 잔상 지우기",
                "다시 불러오기",
                "와이파이 설정",
                "연결 파일 불러오기 (Download/dashboard.txt)",
                "연결 설정 (직접 입력)",
                "기본 홈 화면 바꾸기",
                "절전 설정 (1분 뒤 잠들기)",
                "화면 정보 (크기·알람 기록)",
                "깨우기 시험 (3분 뒤)",
                "기기 설정",
        };
        showDialog(new AlertDialog.Builder(this)
                .setTitle("대시보드 메뉴")
                .setItems(items, (d, which) -> {
                    switch (which) {
                        case 0: webView.evaluateJavascript("window.einkSync && window.einkSync()", null); break;
                        case 1: flashClear(); break;
                        case 2: webView.loadUrl(DASHBOARD_URL); break;
                        case 3: openSettings(Settings.ACTION_WIFI_SETTINGS); break;
                        case 4: importConnectionFile(); break;
                        case 5: showConnectionDialog(); break;
                        case 6: openSettings(Settings.ACTION_HOME_SETTINGS); break;
                        case 7: setupSleep(); break;
                        case 8: showViewportInfo(); break;
                        case 9: testAlarm(); break;
                        case 10: openSettings(Settings.ACTION_SETTINGS); break;
                        default: break;
                    }
                })
                .setNegativeButton("닫기", null)
                .setOnDismissListener(d -> hideSystemBars())
                .create());
    }

    private void openSettings(String action) {
        try {
            startActivity(new Intent(action));
        } catch (ActivityNotFoundException e) {
            try {
                startActivity(new Intent(Settings.ACTION_SETTINGS));
            } catch (ActivityNotFoundException ignored) {
                Toast.makeText(this, "설정을 열 수 없습니다", Toast.LENGTH_SHORT).show();
            }
        }
    }

    /** 전자잉크 잔상 지우기: 화면 전체를 잠깐 검게 칠했다가 되돌린다 */
    private void flashClear() {
        flashOverlay.setVisibility(View.VISIBLE);
        handler.postDelayed(() -> flashOverlay.setVisibility(View.GONE), 400);
    }

    /** Apps Script 웹앱 주소와 토큰을 입력받아 페이지에 넘긴다 (페이지가 localStorage 에 저장) */
    private void showConnectionDialog() {
        int pad = (int) (16 * getResources().getDisplayMetrics().density);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(pad, pad / 2, pad, 0);

        TextView hint = new TextView(this);
        hint.setText("README 2단계에서 만든 웹앱 URL과 TOKEN을 붙여 넣으세요.");
        box.addView(hint);

        final EditText url = new EditText(this);
        url.setHint("https://script.google.com/macros/s/.../exec");
        url.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        url.setText(prefs.getString("gas_url", ""));
        box.addView(url);

        final EditText token = new EditText(this);
        token.setHint("TOKEN");
        token.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
        token.setText(prefs.getString("gas_token", ""));
        box.addView(token);

        showDialog(new AlertDialog.Builder(this)
                .setTitle("연결 설정")
                .setView(box)
                .setPositiveButton("저장", (d, w) -> {
                    String u = url.getText().toString().trim();
                    String t = token.getText().toString().trim();
                    if (u.isEmpty() || t.isEmpty()) {
                        Toast.makeText(this, "주소와 토큰을 모두 입력하세요", Toast.LENGTH_SHORT).show();
                        return;
                    }
                    connect(u, t);
                })
                .setNegativeButton("취소", null)
                .setOnDismissListener(d -> hideSystemBars())
                .create());
    }

    /** 연결 정보를 페이지에 넘긴다. 페이지가 #gas=...&token=... 를 읽어 기기에 저장하고 주소에서 지운다 */
    private void connect(String url, String token) {
        prefs.edit().putString("gas_url", url).putString("gas_token", token).apply();
        webView.loadUrl(DASHBOARD_URL + "#gas=" + Uri.encode(url) + "&token=" + Uri.encode(token));
        Toast.makeText(this, "연결했습니다. 잠시 뒤 일정이 나타납니다", Toast.LENGTH_LONG).show();
    }

    // ---------- 연결 파일 (USB 로 Download 폴더에 넣은 dashboard.txt) ----------

    private void importConnectionFile() {
        if (Build.VERSION.SDK_INT <= 32
                && checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.READ_EXTERNAL_STORAGE}, REQ_READ_STORAGE);
            return;
        }
        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        for (String name : CONNECTION_FILES) {
            File f = new File(dir, name);
            if (!f.isFile()) continue;
            try (InputStream in = new FileInputStream(f)) {
                applyConnectionText(readAll(in));
            } catch (Exception e) {
                Toast.makeText(this, "파일을 읽지 못했습니다: " + e.getMessage(), Toast.LENGTH_LONG).show();
                pickConnectionFile();
            }
            return;
        }
        Toast.makeText(this, "Download 폴더에 dashboard.txt 가 없습니다. 파일을 직접 골라 주세요", Toast.LENGTH_LONG).show();
        pickConnectionFile();
    }

    /** 폴더 위치가 다르거나 권한이 없을 때: 파일 선택 창 */
    private void pickConnectionFile() {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        try {
            startActivityForResult(i, REQ_PICK_FILE);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "파일 선택 창을 열 수 없습니다. '연결 설정 (직접 입력)'을 써 주세요", Toast.LENGTH_LONG).show();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_READ_STORAGE) return;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) importConnectionFile();
        else pickConnectionFile();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        hideSystemBars();
        if (requestCode != REQ_PICK_FILE || resultCode != RESULT_OK || data == null || data.getData() == null) return;
        try (InputStream in = getContentResolver().openInputStream(data.getData())) {
            applyConnectionText(readAll(in));
        } catch (Exception e) {
            Toast.makeText(this, "파일을 읽지 못했습니다: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    /**
     * 받는 형식 (둘 다 가능):
     *   1) 한 줄:  https://script.google.com/macros/s/.../exec?token=XXXX
     *   2) 두 줄:  https://script.google.com/macros/s/.../exec
     *             XXXX
     */
    void applyConnectionText(String raw) {
        String text = raw.replace("\uFEFF", "");   // 메모장이 붙이는 BOM 제거
        Matcher url = EXEC_URL.matcher(text);
        if (!url.find()) {
            Toast.makeText(this, "파일에서 웹앱 주소(.../exec)를 찾지 못했습니다", Toast.LENGTH_LONG).show();
            return;
        }
        String token = null;
        Matcher p = TOKEN_PARAM.matcher(text);
        if (p.find()) token = p.group(1);
        else {
            Matcher l = TOKEN_LINE.matcher(text);
            if (l.find()) token = l.group(1);
        }
        if (token == null) {
            Toast.makeText(this, "파일에서 토큰을 찾지 못했습니다", Toast.LENGTH_LONG).show();
            return;
        }
        connect(url.group(), token);
    }

    private static String readAll(InputStream in) throws java.io.IOException {
        StringBuilder sb = new StringBuilder();
        BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
        String line;
        while ((line = r.readLine()) != null) sb.append(line).append('\n');
        return sb.toString();
    }

    // ---------- 매일 새벽 다시 불러오기 ----------

    // 잠든 동안엔 핸들러 시계가 멈추므로 깨어날 때(onResume)도 확인한다
    private boolean reloadIfNewDay() {
        Calendar now = Calendar.getInstance();
        int day = now.get(Calendar.DAY_OF_YEAR);
        if (day != lastReloadDay && now.get(Calendar.HOUR_OF_DAY) >= DAILY_RELOAD_HOUR) {
            lastReloadDay = day;
            webView.reload();
            return true;
        }
        return false;
    }

    private final Runnable dailyReload = new Runnable() {
        @Override
        public void run() {
            reloadIfNewDay();
            handler.postDelayed(this, CHECK_INTERVAL_MS);
        }
    };

    // ---------- 전체 화면 ----------

    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    @Override
    protected void onResume() {
        super.onResume();
        hideSystemBars();
        webView.onResume();
        // 알람으로 깼으면 10초 뒤 다시 잠들고, 사람이 깨웠으면(전원 버튼) 1분
        long alarmAt = prefs.getLong(WakeReceiver.PREF_ALARM_WAKE_AT, 0);
        boolean byAlarm = System.currentTimeMillis() - alarmAt < ALARM_WAKE_WINDOW_MS;
        if (!byAlarm) setScreenTimeout(this, SCREEN_TIMEOUT_NORMAL);
        log(this, byAlarm ? "화면 켜짐: 알람" : "화면 켜짐: 전원 버튼·돌아옴");
        checkMissedAlarm();
        if (!byAlarm) scheduleTidy();
        // 다시 그리기 (바뀐 칸만 그리므로 바뀐 게 없으면 화면은 그대로)
        if (!reloadIfNewDay()) webView.evaluateJavascript("window.einkRender && window.einkRender()", null);
        scheduleViewportCheck();
    }

    @Override
    public void onUserInteraction() {
        super.onUserInteraction();
        scheduleTidy();
        // 사람이 만지면 알람용 10초 대신 평소 1분으로
        if (prefs.getLong(WakeReceiver.PREF_ALARM_WAKE_AT, 0) != 0) {
            prefs.edit().putLong(WakeReceiver.PREF_ALARM_WAKE_AT, 0).apply();
            setScreenTimeout(this, SCREEN_TIMEOUT_NORMAL);
        }
    }

    @Override
    protected void onPause() {
        webView.onPause();
        super.onPause();
    }

    @Override
    protected void onStop() {
        // 전원 버튼으로 바로 재웠을 때: 창은 다음에 깰 때 사라지도록 지금 닫아 둔다
        handler.removeCallbacks(tidy);
        closeOverlays();
        log(this, "화면 꺼짐");
        super.onStop();
    }

    // ---------- 잠들기 / 알람으로 깨우기 ----------

    static boolean canWriteSettings(Context c) {
        return Build.VERSION.SDK_INT < 23 || Settings.System.canWrite(c);
    }

    /** 시스템 화면 꺼짐 시간 변경 ('시스템 설정 수정' 허용이 있어야 한다) */
    static boolean setScreenTimeout(Context c, int ms) {
        if (!canWriteSettings(c)) return false;
        try {
            int cur = Settings.System.getInt(c.getContentResolver(), Settings.System.SCREEN_OFF_TIMEOUT, -1);
            if (cur == ms) return true;
            return Settings.System.putInt(c.getContentResolver(), Settings.System.SCREEN_OFF_TIMEOUT, ms);
        } catch (SecurityException e) {
            return false;
        }
    }

    /** 페이지가 알려 준 시각에 깨우는 알람. setAlarmClock 은 절전(Doze) 중에도 정확히 울린다 */
    void scheduleWake(long at) {
        AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        if (at <= System.currentTimeMillis()) return;
        // 직전 알람 시각이 이미 지났으면(늦게 울릴 수 있음) 덮어쓰지 않도록 다른 칸(0/1)에 예약한다
        int slot = prefs.getInt("wake_slot", 0);
        if (prefs.getLong("next_wake_at", 0) <= System.currentTimeMillis()) slot = 1 - slot;
        PendingIntent wake = PendingIntent.getBroadcast(this, slot, new Intent(this, WakeReceiver.class),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent show = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        try {
            am.setAlarmClock(new AlarmManager.AlarmClockInfo(at, show), wake);
        } catch (SecurityException e) {
            // 안드로이드 12+ 에서 정확한 알람 권한이 없을 때 (Poke3 는 10 이라 해당 없음)
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, wake);
        }
        prefs.edit().putLong("next_wake_at", at).putInt("wake_slot", slot).apply();
        armDayTimer(at);
    }

    /** 다음 깨울 시각이 가까우면(낮) 포그라운드 서비스가 프로세서를 붙잡고 타이머를 건다. 멀면(밤) 서비스를 멈춰 완전히 잠들게 */
    private void armDayTimer(long at) {
        long delay = at - System.currentTimeMillis();
        if (delay > 0 && delay <= DAY_HOLD_MAX_MS) DayService.arm(this, at);
        else DayService.stop(this);
    }

    /** 메뉴 '깨우기 시험': 3분 뒤 한 번 깨운다 (확실히 깊이 잠든 뒤). 알람과 서비스 타이머를 같은 시각에 건다 */
    private void testAlarm() {
        AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        long at = System.currentTimeMillis() + TEST_DELAY_MS;
        PendingIntent wake = PendingIntent.getBroadcast(this, 9, new Intent(this, WakeReceiver.class).putExtra("test", true),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent show = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        am.setAlarmClock(new AlarmManager.AlarmClockInfo(at, show), wake);
        // 낮 방식(서비스 타이머)도 같은 시각에 — 기록에 둘 중 무엇이 울렸는지 남는다
        DayService.armTest(this, at);
        log(this, "깨우기 시험 예약 → " + new SimpleDateFormat("HH:mm:ss", Locale.KOREA).format(new Date(at)));
        // 바로 재워야 시험이 된다: 화면 꺼짐을 10초로 (만지면 1분으로 돌아감)
        prefs.edit().putLong("test_wake_at", at).putLong(WakeReceiver.PREF_ALARM_WAKE_AT, System.currentTimeMillis()).apply();
        setScreenTimeout(this, SCREEN_TIMEOUT_ALARM);
        Toast.makeText(this, "화면을 만지지 마세요. 10초쯤 뒤 잠들고, 약 3분 뒤 깨어납니다", Toast.LENGTH_LONG).show();
    }

    /** 깨어날 때: 예약해 둔 알람 시각이 지났는데 울린 기록이 없으면 '놓침'으로 남긴다 */
    private void checkMissedAlarm() {
        long now = System.currentTimeMillis();
        long last = prefs.getLong(WakeReceiver.PREF_LAST_ALARM, 0);
        String[] keys = {"next_wake_at", "test_wake_at"};
        for (String k : keys) {
            long at = prefs.getLong(k, 0);
            if (at == 0 || at > now - 5000 || last >= at || prefs.getLong("missed_checked_at", 0) == at) continue;
            log(this, "알람 놓침 (예약 " + new SimpleDateFormat("HH:mm:ss", Locale.KOREA).format(new Date(at)) + ")");
            prefs.edit().putLong("missed_checked_at", at).apply();
        }
    }

    /** 메뉴 '절전 설정': 시스템 설정 수정 권한을 받아 화면 꺼짐 시간을 1분으로 */
    private void setupSleep() {
        if (!canWriteSettings(this)) {
            Toast.makeText(this, "'시스템 설정 수정' 허용을 켠 뒤 돌아와 이 메뉴를 한 번 더 눌러 주세요", Toast.LENGTH_LONG).show();
            try {
                startActivity(new Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS, Uri.parse("package:" + getPackageName())));
            } catch (ActivityNotFoundException e) {
                openSettings(Settings.ACTION_SETTINGS);
            }
            return;
        }
        boolean ok = setScreenTimeout(this, SCREEN_TIMEOUT_NORMAL);
        int now = Settings.System.getInt(getContentResolver(), Settings.System.SCREEN_OFF_TIMEOUT, -1);
        Toast.makeText(this, ok ? "만지지 않으면 " + (now / 1000) + "초 뒤 잠듭니다 (화면은 그대로 남음)"
                : "설정을 바꾸지 못했습니다", Toast.LENGTH_LONG).show();
    }

    // ---------- 화면 크기 확인 (깨어날 때 웹뷰가 액정보다 크게 잡히는 문제) ----------

    private final Runnable viewportCheck = this::checkViewport;

    private void scheduleViewportCheck() {
        handler.removeCallbacks(viewportCheck);
        handler.postDelayed(viewportCheck, VIEWPORT_CHECK_DELAY_MS);
    }

    private static final String VIEWPORT_JS = "(function(){var v=window.visualViewport;return [window.innerWidth,"
            + "window.innerHeight,window.devicePixelRatio,v?v.scale:1,document.documentElement.scrollWidth].join(',');})()";

    private void checkViewport() {
        final int w = webView.getWidth(), h = webView.getHeight();
        if (w == 0 || h == 0) return;
        webView.evaluateJavascript(VIEWPORT_JS, value -> {
            String bad = viewportProblem(value, w, h);
            if (bad == null) {
                if (recoverStage > 0) logRecovery("복구됨 (" + (recoverStage == 1 ? "웹뷰 새로 만들기" : "재시작") + ")");
                recoverStage = 0;
                return;
            }
            recover(bad);
        });
    }

    /** 어긋났으면 무엇이 어긋났는지, 정상이면 null */
    private String viewportProblem(String jsValue, int w, int h) {
        Point real = new Point();
        getWindowManager().getDefaultDisplay().getRealSize(real);
        float density = getResources().getDisplayMetrics().density;
        String v = jsValue == null ? "" : jsValue.replace("\"", "");
        lastViewport = "액정 " + real.x + "×" + real.y + ", 밀도 " + density
                + "\n웹뷰 " + w + "×" + h
                + "\n페이지(폭,높이,배율,확대,내용폭) " + v;
        String[] p = v.split(",");
        if (p.length < 5) return null;   // 페이지가 아직 안 열렸으면 판단하지 않는다
        try {
            double iw = Double.parseDouble(p[0]), ih = Double.parseDouble(p[1]), dpr = Double.parseDouble(p[2]);
            double scale = Double.parseDouble(p[3]), sw = Double.parseDouble(p[4]);
            if (off(w, real.x) && w > real.x) return "웹뷰가 액정보다 넓음";
            if (off(h, real.y) && h > real.y) return "웹뷰가 액정보다 높음";
            if (off(dpr, density)) return "배율 어긋남 " + dpr + "≠" + density;
            if (off(iw * dpr, w) || off(ih * dpr, h)) return "페이지 크기 어긋남";
            if (off(scale, 1)) return "확대됨 " + scale;
            if (sw > iw * (1 + VIEWPORT_TOLERANCE)) return "내용이 화면보다 넓음";
        } catch (NumberFormatException e) {
            return null;
        }
        return null;
    }

    private static boolean off(double a, double b) {
        return Math.abs(a - b) > Math.abs(b) * VIEWPORT_TOLERANCE;
    }

    /** 1단계: 웹뷰를 새로 만든다. 2단계: 앱 프로세스를 다시 시작한다 (홈 앱이라 시스템이 곧바로 다시 띄운다) */
    private void recover(String why) {
        holdScreenForRecovery();
        if (recoverStage == 0) {
            recoverStage = 1;
            logRecovery("어긋남: " + why + " → 웹뷰 새로 만들기");
            recreateWebView();
            return;
        }
        long last = prefs.getLong("restart_at", 0);
        if (System.currentTimeMillis() - last < RESTART_GUARD_MS) {
            logRecovery("어긋남: " + why + " → 재시작해도 그대로 (재부팅 필요)");
            Toast.makeText(this, "화면 크기를 바로잡지 못했습니다. 재부팅해 주세요", Toast.LENGTH_LONG).show();
            recoverStage = 0;
            return;
        }
        logRecovery("어긋남: " + why + " → 앱 다시 시작");
        prefs.edit().putLong("restart_at", System.currentTimeMillis()).commit();
        AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
        if (am != null) {
            PendingIntent pi = PendingIntent.getActivity(this, 1, new Intent(this, MainActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_CANCEL_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            am.set(AlarmManager.RTC, System.currentTimeMillis() + 500, pi);
        }
        finishAffinity();
        Process.killProcess(Process.myPid());
    }

    private void recreateWebView() {
        WebView old = webView;
        webView = new WebView(this);
        setupWebView(webView);
        root.addView(webView, 0, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.removeView(old);
        old.destroy();
        webView.loadUrl(DASHBOARD_URL);
        handler.removeCallbacks(viewportCheck);
        handler.postDelayed(viewportCheck, VIEWPORT_CHECK_DELAY_MS * 2);   // 페이지가 열린 뒤 다시 잰다
    }

    /** 복구하는 동안 화면이 꺼지면 덜 그려진 화면이 남으므로 잠깐 붙잡는다 */
    @SuppressWarnings("deprecation")
    private void holdScreenForRecovery() {
        if (recoverLock == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm == null) return;
            recoverLock = pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ON_AFTER_RELEASE, "eink:recover");
            recoverLock.setReferenceCounted(false);
        }
        recoverLock.acquire(15 * 1000L);
    }

    private void logRecovery(String msg) {
        log(this, msg);
    }

    /** 메뉴 '화면 정보'의 최근 기록 (새것이 위, 15줄까지): 알람으로 깬 시각, 화면 크기 복구 */
    static void log(Context c, String msg) {
        SharedPreferences p = c.getSharedPreferences("eink", Context.MODE_PRIVATE);
        String line = new SimpleDateFormat("MM/dd HH:mm:ss", Locale.KOREA).format(new Date()) + " " + msg;
        String[] lines = (line + "\n" + p.getString("viewport_log", "")).split("\n");
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < lines.length && i < 25; i++) sb.append(lines[i]).append('\n');
        p.edit().putString("viewport_log", sb.toString()).commit();
    }

    /** 메뉴 '화면 정보': 지금 잰 값과 최근 복구 기록. 크기 문제가 다시 보이면 이 화면을 찍어 보내면 된다 */
    private void showViewportInfo() {
        final int w = webView.getWidth(), h = webView.getHeight();
        webView.evaluateJavascript(VIEWPORT_JS, value -> {
            String bad = viewportProblem(value, w, h);
            long next = prefs.getLong("next_wake_at", 0);
            String msg = "판정: " + (bad == null ? "정상" : bad)
                    + "\n\n" + lastViewport
                    + "\n\n다음 알람: " + (next > System.currentTimeMillis()
                        ? new SimpleDateFormat("MM/dd HH:mm:ss", Locale.KOREA).format(new Date(next)) : "없음")
                    + "\n화면 꺼짐 시간: " + Settings.System.getInt(getContentResolver(), Settings.System.SCREEN_OFF_TIMEOUT, -1) / 1000 + "초"
                    + "\n앱 " + BuildConfig.VERSION_NAME
                    + "\n\n최근 기록\n" + prefs.getString("viewport_log", "(없음)");
            showDialog(new AlertDialog.Builder(this)
                    .setTitle("화면 정보")
                    .setMessage(msg)
                    .setPositiveButton("닫기", null)
                    .setOnDismissListener(d -> hideSystemBars())
                    .create());
        });
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // 홈 앱이므로 뒤로 가기로 빠져나가지 않는다
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        webView.destroy();
        if (recoverLock != null && recoverLock.isHeld()) recoverLock.release();
        super.onDestroy();
    }

    /** 페이지 JS 에서 window.EinkApp 으로 보인다 */
    class Bridge {
        @JavascriptInterface
        public String version() {
            return BuildConfig.VERSION_NAME;
        }

        /** 페이지가 '다음에 화면이 바뀔 시각'(epoch ms, 문자열)을 알려 준다 → 그때 깨운다 */
        @JavascriptInterface
        public void scheduleWake(String atMs) {
            final long at;
            try {
                at = Long.parseLong(atMs);
            } catch (NumberFormatException e) {
                return;
            }
            handler.post(() -> MainActivity.this.scheduleWake(at));
        }
    }
}
