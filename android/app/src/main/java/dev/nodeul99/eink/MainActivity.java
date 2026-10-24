package dev.nodeul99.eink;

import android.app.Activity;
import android.app.AlertDialog;
import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
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
import java.util.Calendar;
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

    private WebView webView;
    private View flashOverlay;
    private SharedPreferences prefs;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private int lastReloadDay = -1;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("eink", MODE_PRIVATE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.WHITE);

        webView = new WebView(this);
        setupWebView(webView);
        root.addView(webView, new FrameLayout.LayoutParams(
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

    private void showMenu() {
        final String[] items = {
                "지금 동기화",
                "화면 잔상 지우기",
                "다시 불러오기",
                "와이파이 설정",
                "연결 파일 불러오기 (Download/dashboard.txt)",
                "연결 설정 (직접 입력)",
                "기본 홈 화면 바꾸기",
                "기기 설정",
        };
        new AlertDialog.Builder(this)
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
                        case 7: openSettings(Settings.ACTION_SETTINGS); break;
                        default: break;
                    }
                })
                .setNegativeButton("닫기", null)
                .setOnDismissListener(d -> hideSystemBars())
                .show();
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

        new AlertDialog.Builder(this)
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
                .show();
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

    private final Runnable dailyReload = new Runnable() {
        @Override
        public void run() {
            Calendar now = Calendar.getInstance();
            int day = now.get(Calendar.DAY_OF_YEAR);
            if (day != lastReloadDay && now.get(Calendar.HOUR_OF_DAY) >= DAILY_RELOAD_HOUR) {
                lastReloadDay = day;
                webView.reload();
            }
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
    }

    @Override
    protected void onPause() {
        webView.onPause();
        super.onPause();
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
        super.onDestroy();
    }

    /** 페이지 JS 에서 window.EinkApp 으로 보인다 */
    static class Bridge {
        @JavascriptInterface
        public String version() {
            return BuildConfig.VERSION_NAME;
        }
    }
}
