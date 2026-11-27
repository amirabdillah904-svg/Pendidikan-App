package com.example.offline

import java.net.URLEncoder
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

data class SyncRunResult(
  val attemptedCount: Int,
  val syncedCount: Int,
  val failedCount: Int,
  val lastError: String? = null,
)

/**
 * Coordinates Offline-First persistence (Room) and automatic Google Sheets synchronization
 * via Google Apps Script (`syncOfflineBatch` with automatic per-operation fallback).
 */
class OfflineSyncRepository(
  private val dao: OfflineSyncDao,
  private val gasEndpoint: String = DEFAULT_GAS_ENDPOINT,
  private val httpClient: OkHttpClient =
    OkHttpClient.Builder()
      .connectTimeout(15, TimeUnit.SECONDS)
      .readTimeout(25, TimeUnit.SECONDS)
      .writeTimeout(25, TimeUnit.SECONDS)
      .followRedirects(true)
      .followSslRedirects(true)
      .build(),
) {
  private val syncMutex = Mutex()

  val pendingOperations: Flow<List<PendingSyncEntity>> = dao.observePendingOperations()
  val pendingCount: Flow<Int> = dao.observePendingCount()

  suspend fun enqueueWrite(
    clientOpId: String,
    fnName: String,
    argsJson: String,
    summaryLabel: String,
  ): Int =
    withContext(Dispatchers.IO) {
      val now = System.currentTimeMillis()
      dao.upsertPendingOperation(
        PendingSyncEntity(
          clientOpId = clientOpId,
          fnName = fnName,
          argsJson = argsJson,
          summaryLabel = summaryLabel,
          status = SyncStatus.PENDING,
          retryCount = 0,
          lastError = null,
          createdAt = now,
          updatedAt = now,
        )
      )
      dao.getPendingCountOnce()
    }

  suspend fun deletePendingOperation(clientOpId: String) =
    withContext(Dispatchers.IO) {
      dao.deleteOperation(clientOpId)
    }

  suspend fun cacheReadResponse(cacheKey: String, fnName: String, responseJson: String) =
    withContext(Dispatchers.IO) {
      dao.upsertCachedResponse(
        CachedResponseEntity(
          cacheKey = cacheKey,
          fnName = fnName,
          responseJson = responseJson,
          updatedAt = System.currentTimeMillis(),
        )
      )
    }

  suspend fun getCachedResponse(cacheKey: String): String? =
    withContext(Dispatchers.IO) {
      dao.getCachedResponse(cacheKey)?.responseJson
    }

  suspend fun getAllPendingOperationsOnce(): List<PendingSyncEntity> =
    withContext(Dispatchers.IO) {
      dao.getAllPendingOperations()
    }

  suspend fun syncSingleOperationById(clientOpId: String): SyncRunResult =
    syncMutex.withLock {
      withContext(Dispatchers.IO) {
        val item = dao.getOperationById(clientOpId) ?: return@withContext SyncRunResult(0, 0, 0)
        dao.updateOperationStatus(item.clientOpId, SyncStatus.SYNCING)
        val batchOutcome = tryBatchSync(listOf(item))
        if (batchOutcome != null) {
          return@withContext batchOutcome
        }
        val err = sendSingleOperation(item)
        if (err == null) {
          dao.deleteOperation(item.clientOpId)
          SyncRunResult(attemptedCount = 1, syncedCount = 1, failedCount = 0)
        } else {
          dao.markOperationFailed(item.clientOpId, SyncStatus.FAILED, err)
          SyncRunResult(attemptedCount = 1, syncedCount = 0, failedCount = 1, lastError = err)
        }
      }
    }

  /**
   * Executes a read-only GAS function directly over HTTP so background WorkManager
   * can detect new Pengumuman, Galeri, or Kotak Saran even when the app is closed.
   */
  suspend fun fetchGasReadOnce(fnName: String, args: JSONArray = JSONArray()): String? =
    withContext(Dispatchers.IO) {
      runCatching {
        val payloadObj =
          JSONObject().apply {
            put("fn", fnName)
            put("action", fnName)
            put("args", args)
          }
        val encoded = URLEncoder.encode(payloadObj.toString(), "UTF-8")
        val url = "$gasEndpoint?payload=$encoded"
        val request =
          Request.Builder()
            .url(url)
            .get()
            .header("Accept", "application/json, text/plain, */*")
            .build()
        httpClient.newCall(request).execute().use { response ->
          if (!response.isSuccessful) return@use null
          response.body?.string()?.trim()
        }
      }.getOrNull()
    }

  suspend fun syncAllPending(): SyncRunResult =
    syncMutex.withLock {
      withContext(Dispatchers.IO) {
        val pending = dao.getAllPendingOperations()
        if (pending.isEmpty()) {
          return@withContext SyncRunResult(0, 0, 0)
        }

        pending.forEach { dao.updateOperationStatus(it.clientOpId, SyncStatus.SYNCING) }

        // 1. Try batch endpoint `syncOfflineBatch` first (fast + idempotent with Apps Script SyncLog)
        val batchOutcome = tryBatchSync(pending)
        if (batchOutcome != null) {
          return@withContext batchOutcome
        }

        // 2. Fallback to sending each operation individually for compatibility with existing Apps Script
        var synced = 0
        var failed = 0
        var lastError: String? = null

        for (item in pending) {
          val singleError = sendSingleOperation(item)
          if (singleError == null) {
            dao.deleteOperation(item.clientOpId)
            synced++
          } else {
            dao.markOperationFailed(item.clientOpId, SyncStatus.FAILED, singleError)
            failed++
            lastError = singleError
          }
        }

        SyncRunResult(
          attemptedCount = pending.size,
          syncedCount = synced,
          failedCount = failed,
          lastError = lastError,
        )
      }
    }

  private suspend fun tryBatchSync(items: List<PendingSyncEntity>): SyncRunResult? {
    return try {
      val batchArray = JSONArray()
      items.forEach { item ->
        val argsArr = parseArgsArray(item.argsJson)
        batchArray.put(
          JSONObject().apply {
            put("clientOpId", item.clientOpId)
            put("fn", item.fnName)
            put("args", argsArr)
            put("createdAt", item.createdAt)
          }
        )
      }

      val requestJson =
        JSONObject().apply {
          put("action", "syncOfflineBatch")
          put("fn", "syncOfflineBatch")
          put("args", JSONArray().put(batchArray))
          put("payload", batchArray)
        }

      val bodyText = postJsonToGas(requestJson.toString())
      val parsed = JSONObject(bodyText)

      // Only treat as supported batch response if server explicitly returns `batchHandled: true`
      // or a `results` array matching our offline batch contract.
      if (!parsed.optBoolean("batchHandled", false) && !parsed.has("results")) {
        return null
      }

      val results = parsed.optJSONArray("results") ?: return null
      var synced = 0
      var failed = 0
      var lastError: String? = null
      val handledIds = mutableSetOf<String>()

      for (i in 0 until results.length()) {
        val entry = results.optJSONObject(i) ?: continue
        val opId = entry.optString("clientOpId", "")
        if (opId.isBlank()) continue
        handledIds.add(opId)

        val ok = entry.optBoolean("ok", false) || entry.optBoolean("duplicate", false)
        if (ok) {
          dao.deleteOperation(opId)
          synced++
        } else {
          val err = entry.optString("error", "Gagal sinkronisasi di server")
          dao.markOperationFailed(opId, SyncStatus.FAILED, err)
          failed++
          lastError = err
        }
      }

      // Mark any item missing from server response as pending again
      items.filter { it.clientOpId !in handledIds }.forEach {
        dao.updateOperationStatus(it.clientOpId, SyncStatus.PENDING)
      }

      SyncRunResult(
        attemptedCount = items.size,
        syncedCount = synced,
        failedCount = failed,
        lastError = lastError,
      )
    } catch (_: Exception) {
      null
    }
  }

  private fun sendSingleOperation(item: PendingSyncEntity): String? {
    return try {
      val argsArr = parseArgsArray(item.argsJson)
      val requestJson =
        JSONObject().apply {
          put("action", item.fnName)
          put("fn", item.fnName)
          put("clientOpId", item.clientOpId)
          put("args", argsArr)
          if (argsArr.length() > 0) {
            put("payload", argsArr.get(0))
          }
        }

      val responseText = postJsonToGas(requestJson.toString()).trim()
      if (responseText.isEmpty()) return "Respons server kosong"

      if (responseText.startsWith("{")) {
        val obj = JSONObject(responseText)
        if (obj.has("success") && !obj.optBoolean("success", true)) {
          return obj.optString("message", obj.optString("error", "Operasi ditolak server"))
        }
        if (obj.has("error") && obj.optString("error").isNotBlank()) {
          return obj.optString("error")
        }
      }
      null
    } catch (e: Exception) {
      e.localizedMessage ?: "Gagal terhubung ke Google Apps Script"
    }
  }

  private fun postJsonToGas(jsonBody: String): String {
    val mediaType = "text/plain; charset=utf-8".toMediaType()
    val request =
      Request.Builder()
        .url(gasEndpoint)
        .post(jsonBody.toRequestBody(mediaType))
        .header("Accept", "application/json, text/plain, */*")
        .build()

    httpClient.newCall(request).execute().use { response ->
      if (!response.isSuccessful) {
        throw IllegalStateException("HTTP ${response.code}")
      }
      return response.body?.string().orEmpty()
    }
  }

  companion object {
    const val DEFAULT_GAS_ENDPOINT =
      "https://script.google.com/macros/s/AKfycbxjwgHx5orME-93VGq7XYJVvRvkZGeUKTZaEsZuNrP__Mt9UKw3uonsiiwzFx3tndYpxg/exec"

    fun parseArgsArray(argsJson: String): JSONArray {
      return try {
        JSONArray(argsJson)
      } catch (_: Exception) {
        JSONArray()
      }
    }

    fun buildSummaryLabel(fnName: String, argsJson: String): String {
      val args = parseArgsArray(argsJson)
      val firstObj = args.optJSONObject(0)
      return when (fnName) {
        "submitAbsensi" -> {
          val type = firstObj?.optString("type").orEmpty().uppercase()
          val target = firstObj?.optString("target").orEmpty()
          if (target.isNotBlank()) "Absensi $type • $target" else "Data Absensi"
        }
        "saveFinancialData" -> {
          val cat = args.optString(1, "keuangan")
          val ket = firstObj?.optString("keterangan").orEmpty()
          if (ket.isNotBlank()) "Dana ${cat.replaceFirstChar { it.uppercase() }} • $ket" else "Transaksi Keuangan"
        }
        "deleteFinancialData" -> "Hapus Transaksi Keuangan"
        "savePengumuman" -> "Pengumuman Baru"
        "deletePengumuman" -> "Hapus Pengumuman"
        "saveGaleriData" -> "Unggah Foto Galeri"
        "deleteGaleriData" -> "Hapus Foto Galeri"
        "toggleGaleriLike" -> "Suka Foto Galeri"
        "saveSaran" -> "Kirim Kotak Saran"
        "deleteSaran" -> "Hapus Kotak Saran"
        "saveSuratData" -> {
          val perihal = firstObj?.optString("perihal").orEmpty()
          if (perihal.isNotBlank()) "Arsip Surat • $perihal" else "Simpan Arsip Surat"
        }
        "deleteSurat" -> "Hapus Arsip Surat"
        "saveDbData" -> "Simpan Database (${args.optString(0)})"
        "deleteDbData" -> "Hapus Database (${args.optString(0)})"
        "saveUserData" -> "Simpan Data User"
        "deleteUserData" -> "Hapus Data User"
        "updateAppSettings" -> "Perbarui Setelan Aplikasi"
        else -> "Data ($fnName)"
      }
    }
  }
}
