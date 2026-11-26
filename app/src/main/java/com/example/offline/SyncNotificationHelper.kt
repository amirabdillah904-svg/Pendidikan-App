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
 * Posts real-time Android notifications for:
 * 1. Offline saves & Google Sheet auto-sync completions (Sync channel)
 * 2. New announcements, gallery uploads, and real-time information updates (Info channel)
 */
class SyncNotificationHelper(private val context: Context) {

  init {
    ensureChannels()
  }

  private fun ensureChannels() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
      val syncChannel =
        NotificationChannel(
          CHANNEL_ID,
          context.getString(R.string.sync_channel_name),
          NotificationManager.IMPORTANCE_HIGH,
        ).apply {
          description = context.getString(R.string.sync_channel_desc)
          enableVibration(true)
        }
      val infoChannel =
        NotificationChannel(
          CHANNEL_INFO_ID,
          context.getString(R.string.info_channel_name),
          NotificationManager.IMPORTANCE_HIGH,
        ).apply {
          description = context.getString(R.string.info_channel_desc)
          enableVibration(true)
          enableLights(true)
        }
      manager?.createNotificationChannel(syncChannel)
      manager?.createNotificationChannel(infoChannel)
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
      channelId = CHANNEL_ID,
      notificationId = NOTIF_ID_OFFLINE_SAVED,
      title = context.getString(R.string.notif_offline_saved_title),
      body = context.getString(R.string.notif_offline_saved_body, summaryLabel, pendingCount),
    )
  }

  fun notifySyncSuccess(syncedCount: Int) {
    postNotification(
      channelId = CHANNEL_ID,
      notificationId = NOTIF_ID_SYNC_RESULT,
      title = context.getString(R.string.notif_sync_success_title),
      body = context.getString(R.string.notif_sync_success_body, syncedCount),
    )
  }

  fun notifySyncPartial(syncedCount: Int, remainingCount: Int) {
    postNotification(
      channelId = CHANNEL_ID,
      notificationId = NOTIF_ID_SYNC_RESULT,
      title = context.getString(R.string.notif_sync_partial_title),
      body = context.getString(R.string.notif_sync_partial_body, syncedCount, remainingCount),
    )
  }

  fun notifyOnlineSaved(summaryLabel: String) {
    postNotification(
      channelId = CHANNEL_ID,
      notificationId = NOTIF_ID_ONLINE_SAVED,
      title = context.getString(R.string.notif_online_saved_title),
      body = context.getString(R.string.notif_online_saved_body, summaryLabel),
    )
  }

  fun notifyRealtimeUpdate(title: String, body: String) {
    val cleanTitle = title.trim().ifBlank { context.getString(R.string.app_name) }
    val cleanBody = body.trim()
    if (cleanBody.isBlank()) return
    val uniqueOffset = ((cleanTitle + "|" + cleanBody).hashCode() and 0x3FF)
    postNotification(
      channelId = CHANNEL_INFO_ID,
      notificationId = NOTIF_ID_REALTIME_EVENT + uniqueOffset,
      title = cleanTitle,
      body = cleanBody,
    )
  }

  private fun postNotification(
    channelId: String,
    notificationId: Int,
    title: String,
    body: String,
  ) {
    if (!canPostNotifications()) return
    ensureChannels()
    val notification =
      NotificationCompat.Builder(context, channelId)
        .setSmallIcon(R.mipmap.ic_launcher)
        .setContentTitle(title)
        .setContentText(body)
        .setStyle(NotificationCompat.BigTextStyle().bigText(body))
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .setDefaults(NotificationCompat.DEFAULT_ALL)
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
    const val CHANNEL_INFO_ID = "dept_pendidikan_info_channel"
    private const val NOTIF_ID_OFFLINE_SAVED = 1001
    private const val NOTIF_ID_SYNC_RESULT = 1002
    private const val NOTIF_ID_ONLINE_SAVED = 1003
    private const val NOTIF_ID_REALTIME_EVENT = 2000
  }
}
