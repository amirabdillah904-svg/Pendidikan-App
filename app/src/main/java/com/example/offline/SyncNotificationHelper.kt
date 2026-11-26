package com.example.offline

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.example.MainActivity
import com.example.R

/**
 * Posts real-time Android notifications for offline saves, Google Sheet auto-sync completions,
 * and new server updates while respecting Android 13+ POST_NOTIFICATIONS runtime permissions.
 */
class SyncNotificationHelper(private val context: Context) {

  init {
    ensureChannel()
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
      val channel =
        NotificationChannel(
          CHANNEL_ID,
          context.getString(R.string.sync_channel_name),
          NotificationManager.IMPORTANCE_HIGH,
        ).apply {
          description = context.getString(R.string.sync_channel_desc)
          enableVibration(true)
        }
      manager?.createNotificationChannel(channel)
    }
  }

  private fun canPostNotifications(): Boolean {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
        PackageManager.PERMISSION_GRANTED
    } else {
      true
    }
  }

  private fun contentIntent(): PendingIntent {
    val intent =
      Intent(context, MainActivity::class.java).apply {
        flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
      }
    return PendingIntent.getActivity(
      context,
      0,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  fun notifyOfflineSaved(summaryLabel: String, pendingCount: Int) {
    postNotification(
      notificationId = NOTIF_ID_OFFLINE_SAVED,
      title = context.getString(R.string.notif_offline_saved_title),
      body = context.getString(R.string.notif_offline_saved_body, summaryLabel, pendingCount),
    )
  }

  fun notifySyncSuccess(syncedCount: Int) {
    postNotification(
      notificationId = NOTIF_ID_SYNC_RESULT,
      title = context.getString(R.string.notif_sync_success_title),
      body = context.getString(R.string.notif_sync_success_body, syncedCount),
    )
  }

  fun notifySyncPartial(syncedCount: Int, remainingCount: Int) {
    postNotification(
      notificationId = NOTIF_ID_SYNC_RESULT,
      title = context.getString(R.string.notif_sync_partial_title),
      body = context.getString(R.string.notif_sync_partial_body, syncedCount, remainingCount),
    )
  }

  fun notifyOnlineSaved(summaryLabel: String) {
    postNotification(
      notificationId = NOTIF_ID_ONLINE_SAVED,
      title = context.getString(R.string.notif_online_saved_title),
      body = context.getString(R.string.notif_online_saved_body, summaryLabel),
    )
  }

  fun notifyRealtimeUpdate(title: String, body: String) {
    val cleanTitle = title.trim().ifBlank { context.getString(R.string.app_name) }
    val cleanBody = body.trim()
    if (cleanBody.isBlank()) return
    postNotification(
      notificationId = NOTIF_ID_REALTIME_EVENT + (cleanTitle.hashCode() and 0xFF),
      title = cleanTitle,
      body = cleanBody,
    )
  }

  private fun postNotification(notificationId: Int, title: String, body: String) {
    if (!canPostNotifications()) return
    ensureChannel()
    val notification =
      NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(R.mipmap.ic_launcher)
        .setContentTitle(title)
        .setContentText(body)
        .setStyle(NotificationCompat.BigTextStyle().bigText(body))
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .setAutoCancel(true)
        .setContentIntent(contentIntent())
        .build()

    try {
      NotificationManagerCompat.from(context).notify(notificationId, notification)
    } catch (_: SecurityException) {
      // Ignore if notification permission was revoked concurrently
    }
  }

  companion object {
    const val CHANNEL_ID = "dept_pendidikan_sync_channel"
    private const val NOTIF_ID_OFFLINE_SAVED = 1001
    private const val NOTIF_ID_SYNC_RESULT = 1002
    private const val NOTIF_ID_ONLINE_SAVED = 1003
    private const val NOTIF_ID_REALTIME_EVENT = 2000
  }
}
