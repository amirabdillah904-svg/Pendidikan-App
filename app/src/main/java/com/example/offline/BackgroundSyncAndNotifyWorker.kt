package com.example.offline

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.Calendar
import java.util.TimeZone
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject

/**
 * Play-policy compliant background worker (WorkManager) that runs even when the app is closed:
 * 1. Automatically syncs any pending/stalled Room offline writes once connectivity returns
 *    (when Admin auto-upload is enabled) and posts a real Android notification.
 * 2. Polls Google Apps Script for new Pengumuman, Galeri Santri, and (for Admin) Kotak Saran,
 *    delivering standard Android push-style notifications even while the app is closed.
 */
class BackgroundSyncAndNotifyWorker(
  appContext: Context,
  workerParams: WorkerParameters,
) : CoroutineWorker(appContext, workerParams) {

  override suspend fun doWork(): Result {
    val ctx = applicationContext
    val dao = OfflineDatabase.getInstance(ctx).offlineSyncDao()
    val repository = OfflineSyncRepository(dao)
    val notifier = SyncNotificationHelper(ctx)

    var shouldRetrySync = false

    // 1. Background auto-upload for stalled/pending offline queue
    val pendingBefore = repository.getAllPendingOperationsOnce()
    if (pendingBefore.isNotEmpty() && BackgroundSyncPrefs.isAutoUploadOfflineEnabled(ctx)) {
      val syncResult = runCatching { repository.syncAllPending() }.getOrNull()
      if (syncResult != null) {
        when {
          syncResult.syncedCount > 0 && syncResult.failedCount == 0 -> {
            notifier.notifySyncSuccess(syncResult.syncedCount)
          }
          syncResult.syncedCount > 0 && syncResult.failedCount > 0 -> {
            notifier.notifySyncPartial(syncResult.syncedCount, syncResult.failedCount)
            shouldRetrySync = true
          }
          syncResult.failedCount > 0 -> {
            shouldRetrySync = true
          }
        }
      } else {
        shouldRetrySync = true
      }
    }

    // 2. Background real-time notifications for new Pengumuman / Galeri / Kotak Saran + Deadline Reminder
    if (BackgroundSyncPrefs.isBackgroundNotifEnabled(ctx)) {
      checkAttendanceDeadlineReminder(ctx, notifier)
      checkNewAnnouncementsAndGallery(ctx, repository, notifier)
      if (BackgroundSyncPrefs.getCurrentUserRole(ctx) == "admin") {
        checkNewSaranForAdmin(ctx, repository, notifier)
      }
    }

    return if (shouldRetrySync && runAttemptCount < 3) Result.retry() else Result.success()
  }

  private fun checkAttendanceDeadlineReminder(
    ctx: Context,
    notifier: SyncNotificationHelper,
  ) {
    val role = BackgroundSyncPrefs.getCurrentUserRole(ctx)
    if (role.isBlank() || role == "walisantri") return

    val rawDeadlines = BackgroundSyncPrefs.getAttendanceDeadlinesJson(ctx)
    val deadlinesObj =
      runCatching { if (rawDeadlines.isNotBlank()) JSONObject(rawDeadlines) else null }.getOrNull()
        ?: return

    val cal = Calendar.getInstance(TimeZone.getTimeZone("Asia/Jakarta"))
    val nowMin = cal.get(Calendar.HOUR_OF_DAY) * 60 + cal.get(Calendar.MINUTE)
    val todayKey = "${cal.get(Calendar.YEAR)}-${cal.get(Calendar.MONTH) + 1}-${cal.get(Calendar.DAY_OF_MONTH)}"

    val targets =
      when (role) {
        "musyrif" -> listOf("wb" to "Absensi Wajib Belajar", "musyrif" to "Absensi Musyrif")
        "pengajar" -> listOf("takhassus" to "Absensi Takhassus", "pengajar" to "Absensi Pengajar")
        else -> listOf("wb" to "Absensi Wajib Belajar", "takhassus" to "Absensi Takhassus")
      }

    for ((key, label) in targets) {
      val cfg = deadlinesObj.optJSONObject(key) ?: continue
      if (!cfg.optBoolean("enabled", true)) continue
      val timeStr = cfg.optString("time", "").trim()
      val parts = timeStr.split(":")
      if (parts.size != 2) continue
      val hh = parts[0].toIntOrNull() ?: continue
      val mm = parts[1].toIntOrNull() ?: continue
      val deadlineMin = hh * 60 + mm
      val diff = deadlineMin - nowMin
      if (diff in 1..15) {
        val sentKey = "${todayKey}_${key}"
        if (BackgroundSyncPrefs.getLastDeadlineReminderKey(ctx) != sentKey) {
          BackgroundSyncPrefs.setLastDeadlineReminderKey(ctx, sentKey)
          notifier.notifyRealtimeUpdate(
            "Pengingat $label",
            "Batas waktu absen pukul $timeStr WIB ($diff menit lagi). Segera selesaikan absensi agar tidak tercatat terlambat.",
          )
        }
        break
      }
    }
  }

  private suspend fun checkNewAnnouncementsAndGallery(
    ctx: Context,
    repository: OfflineSyncRepository,
    notifier: SyncNotificationHelper,
  ) {
    // Check getFastLoginData for latest Pengumuman (and optional Galeri)
    val fastRaw = repository.fetchGasReadOnce("getFastLoginData")
    if (!fastRaw.isNullOrBlank() && fastRaw.startsWith("{")) {
      runCatching {
        val obj = JSONObject(fastRaw)
        val pengumumanArr = obj.optJSONArray("pengumuman")
        if (pengumumanArr != null && pengumumanArr.length() > 0) {
          val latest = pengumumanArr.optJSONObject(0)
          if (latest != null) {
            val latestId = buildPengumumanId(latest)
            val prevId = BackgroundSyncPrefs.getLastSeenPengumumanId(ctx)
            if (prevId.isNotBlank() && prevId != latestId) {
              val author = latest.optString("penulis").trim()
              val isi = latest.optString("isi").trim().ifBlank { "Ada informasi baru dari Departemen Pendidikan." }
              val body = if (author.isNotBlank()) "$isi ($author)" else isi
              notifier.notifyRealtimeUpdate("Informasi Baru • Dept. Pendidikan", body)
            }
            BackgroundSyncPrefs.setLastSeenPengumumanId(ctx, latestId)
          }
        }
      }
    }

    // Check getGaleriData for latest Galeri Santri upload
    val galeriRaw = repository.fetchGasReadOnce("getGaleriData")
    if (!galeriRaw.isNullOrBlank() && galeriRaw.startsWith("[")) {
      runCatching {
        val arr = JSONArray(galeriRaw)
        if (arr.length() > 0) {
          val latest = arr.optJSONObject(0)
          if (latest != null) {
            val latestId = buildGaleriId(latest)
            val prevId = BackgroundSyncPrefs.getLastSeenGaleriId(ctx)
            if (prevId.isNotBlank() && prevId != latestId) {
              val tag = latest.optString("tag").trim()
              val caption =
                latest.optString("caption").trim().ifBlank {
                  "Foto dokumentasi kegiatan santri terbaru telah diunggah."
                }
              val penulis = latest.optString("penulis").trim()
              val body =
                buildString {
                  if (tag.isNotBlank()) append("[$tag] ")
                  append(caption)
                  if (penulis.isNotBlank()) append(" — $penulis")
                }
              notifier.notifyRealtimeUpdate("Galeri Santri Baru • Dept. Pendidikan", body)
            }
            BackgroundSyncPrefs.setLastSeenGaleriId(ctx, latestId)
          }
        }
      }
    }
  }

  private suspend fun checkNewSaranForAdmin(
    ctx: Context,
    repository: OfflineSyncRepository,
    notifier: SyncNotificationHelper,
  ) {
    val saranRaw = repository.fetchGasReadOnce("getSaran")
    if (!saranRaw.isNullOrBlank() && saranRaw.startsWith("[")) {
      runCatching {
        val arr = JSONArray(saranRaw)
        if (arr.length() > 0) {
          val latest = arr.optJSONObject(0)
          if (latest != null) {
            val latestId =
              latest.optString("id").trim().ifBlank {
                "${latest.optString("tanggal")}_${latest.optString("isi").take(35)}"
              }
            val prevId = BackgroundSyncPrefs.getLastSeenSaranId(ctx)
            if (prevId.isNotBlank() && prevId != latestId) {
              val pengirim = latest.optString("pengirim").trim().ifBlank { "Pengguna" }
              val isi = latest.optString("isi").trim().ifBlank { "Ada masukan baru di Kotak Saran." }
              notifier.notifyRealtimeUpdate("Kotak Saran Baru • $pengirim", isi)
            }
            BackgroundSyncPrefs.setLastSeenSaranId(ctx, latestId)
          }
        }
      }
    }
  }

  private fun buildPengumumanId(obj: JSONObject): String {
    val id = obj.optString("id").trim()
    if (id.isNotBlank()) return id
    return "${obj.optString("tanggal")}_${obj.optString("isi").take(40)}"
  }

  private fun buildGaleriId(obj: JSONObject): String {
    val id = obj.optString("id").trim()
    if (id.isNotBlank()) return id
    return "${obj.optString("tanggal")}_${obj.optString("caption").take(30)}"
  }

  companion object {
    private const val PERIODIC_WORK_NAME = "alrifaie_bg_sync_notify_periodic"
    private const val ONE_TIME_SYNC_NAME = "alrifaie_bg_sync_once"

    fun schedulePeriodicWork(context: Context) {
      val constraints =
        Constraints.Builder()
          .setRequiredNetworkType(NetworkType.CONNECTED)
          .build()

      val periodicRequest =
        PeriodicWorkRequestBuilder<BackgroundSyncAndNotifyWorker>(15, TimeUnit.MINUTES)
          .setConstraints(constraints)
          .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
          .build()

      WorkManager.getInstance(context.applicationContext)
        .enqueueUniquePeriodicWork(
          PERIODIC_WORK_NAME,
          ExistingPeriodicWorkPolicy.KEEP,
          periodicRequest,
        )
    }

    fun enqueueImmediateConnectedSync(context: Context) {
      val constraints =
        Constraints.Builder()
          .setRequiredNetworkType(NetworkType.CONNECTED)
          .build()

      val oneTimeRequest =
        OneTimeWorkRequestBuilder<BackgroundSyncAndNotifyWorker>()
          .setConstraints(constraints)
          .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
          .build()

      WorkManager.getInstance(context.applicationContext)
        .enqueueUniqueWork(
          ONE_TIME_SYNC_NAME,
          ExistingWorkPolicy.REPLACE,
          oneTimeRequest,
        )
    }
  }
}
