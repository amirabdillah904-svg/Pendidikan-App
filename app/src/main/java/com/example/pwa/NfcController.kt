package com.example.pwa

import android.app.Activity
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.nfc.NdefMessage
import android.nfc.NdefRecord
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.nfc.tech.Ndef
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import java.nio.charset.StandardCharsets
import org.json.JSONArray
import org.json.JSONObject

/**
 * Native Android NFC Controller with exclusive foreground ReaderMode locking.
 *
 * When locked (e.g., on Wajib Belajar / Takhassus attendance forms or Database NFC binding),
 * `NfcAdapter.enableReaderMode` captures all NFC tags exclusively inside the app so Android's
 * built-in NFC dispatcher or other apps are never triggered.
 *
 * Supports read-only hardware UID + NDEF Text/URI/MIME reading so student cards shared with
 * other NFC services (e.g., canteen, library, dorm access) stay intact and interoperable.
 */
class NfcController(
  private val activity: Activity,
  private val onTagScanned: (jsonPayload: String) -> Unit,
  private val onStatusChanged: (jsonStatus: String) -> Unit,
) {

  private val nfcAdapter: NfcAdapter? = NfcAdapter.getDefaultAdapter(activity)
  private var isResumed = false
  @Volatile private var isLocked = false
  @Volatile private var currentMode = "idle"
  @Volatile private var lastUid = ""
  @Volatile private var lastScanTimeMs = 0L

  val isSupported: Boolean
    get() = nfcAdapter != null

  val isEnabled: Boolean
    get() = nfcAdapter?.isEnabled == true

  fun getStatusJson(): String {
    return JSONObject()
      .put("supported", isSupported)
      .put("enabled", isEnabled)
      .put("locked", isLocked && isEnabled)
      .put("mode", currentMode)
      .toString()
  }

  fun setLockMode(locked: Boolean, mode: String) {
    isLocked = locked
    currentMode = mode.ifBlank { if (locked) "attendance" else "idle" }
    activity.runOnUiThread {
      applyNfcDispatchState()
      onStatusChanged(getStatusJson())
    }
  }

  fun openNfcSettings() {
    runCatching {
      val intent =
        Intent(Settings.ACTION_NFC_SETTINGS).apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
      activity.startActivity(intent)
    }
  }

  fun onResume() {
    isResumed = true
    applyNfcDispatchState()
    onStatusChanged(getStatusJson())
  }

  fun onPause() {
    isResumed = false
    disableAllDispatch()
  }

  fun handleIntent(intent: Intent?) {
    if (intent == null) return
    val action = intent.action ?: return
    if (
      action == NfcAdapter.ACTION_NDEF_DISCOVERED ||
        action == NfcAdapter.ACTION_TECH_DISCOVERED ||
        action == NfcAdapter.ACTION_TAG_DISCOVERED
    ) {
      val tag: Tag? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          intent.getParcelableExtra(NfcAdapter.EXTRA_TAG, Tag::class.java)
        } else {
          @Suppress("DEPRECATION")
          intent.getParcelableExtra(NfcAdapter.EXTRA_TAG)
        }
      if (tag != null) {
        processTag(tag, fromIntent = true)
      }
    }
  }

  private fun applyNfcDispatchState() {
    val adapter = nfcAdapter ?: return
    if (!isResumed) return

    if (!adapter.isEnabled) {
      disableAllDispatch()
      return
    }

    if (isLocked) {
      // Exclusive ReaderMode lock: prevents Android system NFC / other apps from stealing card taps
      runCatching { adapter.disableForegroundDispatch(activity) }
      val flags =
        NfcAdapter.FLAG_READER_NFC_A or
          NfcAdapter.FLAG_READER_NFC_B or
          NfcAdapter.FLAG_READER_NFC_F or
          NfcAdapter.FLAG_READER_NFC_V or
          NfcAdapter.FLAG_READER_NFC_BARCODE or
          NfcAdapter.FLAG_READER_NO_PLATFORM_SOUNDS
      val extras = Bundle().apply {
        putInt(NfcAdapter.EXTRA_READER_PRESENCE_CHECK_DELAY, 250)
      }
      runCatching {
        adapter.enableReaderMode(
          activity,
          { tag -> processTag(tag, fromIntent = false) },
          flags,
          extras,
        )
      }
    } else {
      // Standard foreground dispatch while app is visible: keeps accidental taps inside app
      runCatching { adapter.disableReaderMode(activity) }
      runCatching {
        val intent =
          Intent(activity, activity.javaClass).apply {
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
          }
        val mutabilityFlag =
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
        val pendingIntent =
          PendingIntent.getActivity(activity, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or mutabilityFlag)
        val filters =
          arrayOf(
            IntentFilter(NfcAdapter.ACTION_TAG_DISCOVERED),
            IntentFilter(NfcAdapter.ACTION_TECH_DISCOVERED),
            IntentFilter(NfcAdapter.ACTION_NDEF_DISCOVERED),
          )
        adapter.enableForegroundDispatch(activity, pendingIntent, filters, null)
      }
    }
  }

  private fun disableAllDispatch() {
    val adapter = nfcAdapter ?: return
    runCatching { adapter.disableReaderMode(activity) }
    runCatching { adapter.disableForegroundDispatch(activity) }
  }

  private fun processTag(tag: Tag, fromIntent: Boolean) {
    val uidBytes = tag.id ?: ByteArray(0)
    val uidHex = uidBytes.joinToString("") { "%02X".format(it) }
    val uidColon = uidBytes.joinToString(":") { "%02X".format(it) }
    val ndefText = extractNdefText(tag)
    val effectiveCode = uidHex.ifBlank { ndefText.trim() }
    if (effectiveCode.isBlank()) return

    val now = System.currentTimeMillis()
    if (effectiveCode == lastUid && (now - lastScanTimeMs) < 1100L) {
      return
    }
    lastUid = effectiveCode
    lastScanTimeMs = now

    vibrateFeedback(50L)

    val techJson = JSONArray()
    tag.techList?.forEach { tech ->
      techJson.put(tech.substringAfterLast('.'))
    }

    val payload =
      JSONObject()
        .put("uid", uidHex)
        .put("uidColon", uidColon)
        .put("ndef", ndefText)
        .put("code", effectiveCode)
        .put("mode", currentMode)
        .put("locked", isLocked)
        .put("fromIntent", fromIntent)
        .put("techs", techJson)
        .put("timestamp", now)
        .toString()

    // Broadcast locally so other integrated NFC modules/services can synchronize if subscribed
    runCatching {
      val syncIntent =
        Intent(ACTION_NFC_SCANNED).apply {
          setPackage(activity.packageName)
          putExtra("nfc_uid", uidHex)
          putExtra("nfc_uid_colon", uidColon)
          putExtra("ndef_text", ndefText)
          putExtra("mode", currentMode)
        }
      activity.sendBroadcast(syncIntent)
    }

    activity.runOnUiThread {
      onTagScanned(payload)
    }
  }

  private fun extractNdefText(tag: Tag): String {
    return runCatching {
      val ndef = Ndef.get(tag) ?: return@runCatching ""
      val msg: NdefMessage? =
        ndef.cachedNdefMessage ?: run {
          ndef.connect()
          val read = ndef.ndefMessage
          runCatching { ndef.close() }
          read
        }
      val record = msg?.records?.firstOrNull() ?: return@runCatching ""
      parseNdefRecord(record)
    }.getOrDefault("")
  }

  private fun parseNdefRecord(record: NdefRecord): String {
    val payload = record.payload ?: return ""
    if (payload.isEmpty()) return ""
    return when {
      record.tnf == NdefRecord.TNF_WELL_KNOWN && record.type.contentEquals(NdefRecord.RTD_TEXT) -> {
        val statusByte = payload[0].toInt()
        val isUtf16 = (statusByte and 0x80) != 0
        val langLen = statusByte and 0x3F
        if (payload.size <= 1 + langLen) {
          ""
        } else {
          val charset = if (isUtf16) StandardCharsets.UTF_16 else StandardCharsets.UTF_8
          String(payload, 1 + langLen, payload.size - 1 - langLen, charset).trim()
        }
      }
      record.tnf == NdefRecord.TNF_WELL_KNOWN && record.type.contentEquals(NdefRecord.RTD_URI) -> {
        val uri = record.toUri()
        uri?.toString()?.trim().orEmpty()
      }
      else -> String(payload, StandardCharsets.UTF_8).trim()
    }
  }

  fun vibrateFeedback(durationMs: Long) {
    runCatching {
      val ms = durationMs.coerceIn(15L, 250L)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        val vm = activity.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
        vm?.defaultVibrator?.vibrate(
          VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE)
        )
      } else {
        @Suppress("DEPRECATION")
        val vibrator = activity.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          vibrator?.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE))
        } else {
          @Suppress("DEPRECATION")
          vibrator?.vibrate(ms)
        }
      }
    }
  }

  companion object {
    const val ACTION_NFC_SCANNED = "com.aistudio.deptpendidikan.rfaieq.ACTION_NFC_SCANNED"
  }
}
