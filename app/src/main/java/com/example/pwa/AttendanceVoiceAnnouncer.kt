package com.example.pwa

import android.content.Context
import android.media.AudioAttributes
import android.speech.tts.TextToSpeech
import java.util.Locale

/**
 * Native Indonesian Text-to-Speech announcer for NFC/QR attendance scans.
 * Works reliably offline inside Android WebView where Web Speech API is often unavailable.
 */
class AttendanceVoiceAnnouncer(context: Context) : TextToSpeech.OnInitListener {

  private val appContext = context.applicationContext
  private var tts: TextToSpeech? = null
  @Volatile private var isReady = false
  @Volatile private var isShutdown = false
  @Volatile private var pendingUtterance: String? = null

  init {
    runCatching {
      tts = TextToSpeech(appContext, this)
    }
  }

  override fun onInit(status: Int) {
    if (isShutdown) {
      shutdown()
      return
    }
    if (status != TextToSpeech.SUCCESS) {
      isReady = false
      return
    }
    val engine = tts ?: return
    runCatching {
      engine.setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build()
      )
    }
    val idLocale = Locale("id", "ID")
    val langResult = engine.setLanguage(idLocale)
    if (langResult == TextToSpeech.LANG_MISSING_DATA || langResult == TextToSpeech.LANG_NOT_SUPPORTED) {
      engine.setLanguage(Locale("in", "ID"))
    }
    engine.setSpeechRate(1.0f)
    engine.setPitch(1.0f)
    isReady = true

    val queued = pendingUtterance
    pendingUtterance = null
    if (!queued.isNullOrBlank()) {
      speakInternal(queued)
    }
  }

  fun speak(rawText: String) {
    if (isShutdown) return
    val text = rawText.trim().take(240)
    if (text.isEmpty()) return

    if (!isReady) {
      pendingUtterance = text
      return
    }
    speakInternal(text)
  }

  private fun speakInternal(text: String) {
    runCatching {
      tts?.speak(
        text,
        TextToSpeech.QUEUE_FLUSH,
        null,
        "alrifaie_scan_${System.currentTimeMillis()}",
      )
    }
  }

  fun shutdown() {
    isShutdown = true
    isReady = false
    pendingUtterance = null
    runCatching {
      tts?.stop()
      tts?.shutdown()
    }
    tts = null
  }
}
