package dev.nodeul99.eink;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.PowerManager;

/**
 * 알람(또는 낮 동안의 앱 타이머)이 울리면 화면을 잠깐 켠다.
 * 대시보드가 맨 위(홈 앱)에 있으므로 화면이 켜지면 MainActivity.onResume 이 다시 그린다.
 * 화면 꺼짐 시간을 10초로 줄여 두어, 다 그린 뒤 곧바로 다시 잠든다 (사람이 만지면 1분으로 돌아감).
 */
public class WakeReceiver extends BroadcastReceiver {

    static final String PREF_ALARM_WAKE_AT = "alarm_wake_at";
    static final String PREF_LAST_ALARM = "last_alarm_at";   // 지우지 않는 '마지막으로 알람이 울린 시각'

    @Override
    public void onReceive(Context context, Intent intent) {
        wakeScreen(context, intent.getBooleanExtra("test", false) ? "알람 시험 울림" : "알람 울림");
    }

    /** 화면을 켜고 짧게(10초) 다시 잠들게 한다. why 는 '화면 정보' 기록에 남는다 */
    @SuppressWarnings("deprecation")
    static void wakeScreen(Context context, String why) {
        long now = System.currentTimeMillis();
        context.getSharedPreferences("eink", Context.MODE_PRIVATE).edit()
                .putLong(PREF_ALARM_WAKE_AT, now).putLong(PREF_LAST_ALARM, now).commit();
        MainActivity.setScreenTimeout(context, MainActivity.SCREEN_TIMEOUT_ALARM);
        MainActivity.log(context, why + " → 화면 켬");
        PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        if (pm == null) return;
        PowerManager.WakeLock lock = pm.newWakeLock(
                PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP, "eink:alarm");
        lock.acquire(8 * 1000L);   // 다시 그릴 시간. 풀린 뒤엔 화면 꺼짐 시간(10초)이 지나면 잠든다
    }
}
