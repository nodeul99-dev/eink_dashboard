package dev.nodeul99.eink;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 낮 동안 잠든 화면을 정해진 시각에 켜는 포그라운드 서비스.
 *
 * Poke3 는 깊이 잠든 동안 앱 알람을 받지 않고, 액티비티가 붙잡은 wake lock 도 무시하고 재운다(2026-10-26 확인).
 * BOOX 는 백그라운드에서 '재생 중'인 앱(음악 앱 등)은 살려 두므로, 음악 앱처럼 포그라운드 서비스로
 * 프로세서를 붙잡고 타이머를 돌린다. 밤에는 MainActivity 가 서비스를 멈춰 완전히 잠들게 한다.
 */
public class DayService extends Service {

    static final String EXTRA_AT = "at";            // 평소 깨울 시각 (epoch ms)
    static final String EXTRA_TEST_AT = "test_at";  // 메뉴 '깨우기 시험' 시각
    private static final String CHANNEL = "day";
    private static final int NOTIFICATION_ID = 1;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private PowerManager.WakeLock lock;
    private long at, testAt;

    private final Runnable wake = () -> WakeReceiver.wakeScreen(this, "타이머");
    private final Runnable testWake = () -> WakeReceiver.wakeScreen(this, "타이머 시험");

    /** 다음 깨울 시각을 서비스에 넘긴다 (서비스가 없으면 시작) */
    static void arm(Context c, long at) {
        c.startForegroundService(new Intent(c, DayService.class).putExtra(EXTRA_AT, at));
    }

    static void armTest(Context c, long testAt) {
        c.startForegroundService(new Intent(c, DayService.class).putExtra(EXTRA_TEST_AT, testAt));
    }

    static void stop(Context c) {
        c.stopService(new Intent(c, DayService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NOTIFICATION_ID, notification());
        long now = System.currentTimeMillis();
        if (intent != null && intent.hasExtra(EXTRA_AT)) {
            at = intent.getLongExtra(EXTRA_AT, 0);
            handler.removeCallbacks(wake);
            if (at > now) handler.postDelayed(wake, at - now);
        }
        if (intent != null && intent.hasExtra(EXTRA_TEST_AT)) {
            testAt = intent.getLongExtra(EXTRA_TEST_AT, 0);
            handler.removeCallbacks(testWake);
            if (testAt > now) handler.postDelayed(testWake, testAt - now);
        }
        // 가장 늦은 예약 + 1분까지만 붙잡는다 (혹시 타이머가 안 돌아도 계속 붙잡지 않게)
        long until = Math.max(at, testAt);
        if (until > now) holdCpu(until - now + 60 * 1000L);
        MainActivity.log(this, "타이머 대기 → " + new SimpleDateFormat("HH:mm:ss", Locale.KOREA).format(new Date(until)));
        return START_STICKY;
    }

    @SuppressWarnings("deprecation")
    private Notification notification() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null && nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "책갈피 교체", NotificationManager.IMPORTANCE_MIN));
        }
        return new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_popup_reminder)
                .setContentTitle("대시보드: 책갈피 교체 대기 중")
                .setOngoing(true)
                .build();
    }

    private void holdCpu(long ms) {
        if (lock == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm == null) return;
            lock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "eink:day");
            lock.setReferenceCounted(false);
        }
        lock.acquire(ms);
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (lock != null && lock.isHeld()) lock.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
