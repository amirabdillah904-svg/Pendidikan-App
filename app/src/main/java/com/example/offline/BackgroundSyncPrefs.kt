package com.example.offline

import android.content.Context

/**
 * Persists background notification cursors and admin auto-upload preferences across app restarts
 * so WorkManager can post notifications and sync stalled offline writes even when the app is closed.
 */
object BackgroundSyncPrefs {
  private const val PREF_NAME = "alrifaie_bg_sync_prefs"
  private const val KEY_AUTO_UPLOAD_OFFLINE = "auto_upload_offline_enabled"
  private const val KEY_BG_NOTIF_ENABLED = "bg_notif_enabled"
  private const val KEY_LAST_PENGUMUMAN_ID = "last_seen_pengumuman_id"
  private const val KEY_LAST_GALERI_ID = "last_seen_galeri_id"
  private const val KEY_LAST_SARAN_ID = "last_seen_saran_id"
  private const val KEY_USER_ROLE = "current_user_role"
  private const val KEY_ATTENDANCE_DEADLINES_JSON = "attendance_deadlines_json"
  private const val KEY_LAST_DEADLINE_REMINDER = "last_deadline_reminder_key"

  private fun prefs(context: Context) =
    context.applicationContext.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)

  fun isAutoUploadOfflineEnabled(context: Context): Boolean =
    prefs(context).getBoolean(KEY_AUTO_UPLOAD_OFFLINE, true)

  fun setAutoUploadOfflineEnabled(context: Context, enabled: Boolean) {
    prefs(context).edit().putBoolean(KEY_AUTO_UPLOAD_OFFLINE, enabled).apply()
  }

  fun isBackgroundNotifEnabled(context: Context): Boolean =
    prefs(context).getBoolean(KEY_BG_NOTIF_ENABLED, true)

  fun setBackgroundNotifEnabled(context: Context, enabled: Boolean) {
    prefs(context).edit().putBoolean(KEY_BG_NOTIF_ENABLED, enabled).apply()
  }

  fun getLastSeenPengumumanId(context: Context): String =
    prefs(context).getString(KEY_LAST_PENGUMUMAN_ID, "").orEmpty()

  fun setLastSeenPengumumanId(context: Context, id: String) {
    if (id.isNotBlank()) {
      prefs(context).edit().putString(KEY_LAST_PENGUMUMAN_ID, id).apply()
    }
  }

  fun getLastSeenGaleriId(context: Context): String =
    prefs(context).getString(KEY_LAST_GALERI_ID, "").orEmpty()

  fun setLastSeenGaleriId(context: Context, id: String) {
    if (id.isNotBlank()) {
      prefs(context).edit().putString(KEY_LAST_GALERI_ID, id).apply()
    }
  }

  fun getLastSeenSaranId(context: Context): String =
    prefs(context).getString(KEY_LAST_SARAN_ID, "").orEmpty()

  fun setLastSeenSaranId(context: Context, id: String) {
    if (id.isNotBlank()) {
      prefs(context).edit().putString(KEY_LAST_SARAN_ID, id).apply()
    }
  }

  fun getCurrentUserRole(context: Context): String =
    prefs(context).getString(KEY_USER_ROLE, "").orEmpty()

  fun setCurrentUserRole(context: Context, role: String) {
    prefs(context).edit().putString(KEY_USER_ROLE, role.trim().lowercase()).apply()
  }

  fun getAttendanceDeadlinesJson(context: Context): String =
    prefs(context).getString(KEY_ATTENDANCE_DEADLINES_JSON, "").orEmpty()

  fun setAttendanceDeadlinesJson(context: Context, json: String) {
    if (json.isNotBlank()) {
      prefs(context).edit().putString(KEY_ATTENDANCE_DEADLINES_JSON, json).apply()
    }
  }

  fun getLastDeadlineReminderKey(context: Context): String =
    prefs(context).getString(KEY_LAST_DEADLINE_REMINDER, "").orEmpty()

  fun setLastDeadlineReminderKey(context: Context, key: String) {
    prefs(context).edit().putString(KEY_LAST_DEADLINE_REMINDER, key).apply()
  }
}
