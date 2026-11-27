package com.example

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.core.view.WindowCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.example.pwa.NfcController
import com.example.pwa.PwaViewModel
import com.example.pwa.PwaWebViewScreen
import com.example.ui.theme.DeptPendidikanTheme
import java.io.File
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow

class MainActivity : ComponentActivity() {

  private val viewModel: PwaViewModel by viewModels()
  private val _nfcTagEvents = MutableSharedFlow<String>(extraBufferCapacity = 8)
  private val _nfcStatusState = MutableStateFlow("{\"supported\":false,\"enabled\":false,\"locked\":false,\"mode\":\"idle\"}")
  private lateinit var nfcController: NfcController

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    ensureWebViewCacheDirectories()
    enableEdgeToEdge()

    nfcController =
      NfcController(
        activity = this,
        onTagScanned = { payloadJson -> _nfcTagEvents.tryEmit(payloadJson) },
        onStatusChanged = { statusJson -> _nfcStatusState.value = statusJson },
      )
    _nfcStatusState.value = nfcController.getStatusJson()
    nfcController.handleIntent(intent)

    setContent {
      val uiState by viewModel.uiState.collectAsStateWithLifecycle()

      LaunchedEffect(uiState.isDarkTheme) {
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.isAppearanceLightStatusBars = !uiState.isDarkTheme
        controller.isAppearanceLightNavigationBars = !uiState.isDarkTheme
      }

      DeptPendidikanTheme(darkTheme = uiState.isDarkTheme) {
        PwaWebViewScreen(
          viewModel = viewModel,
          onExitApp = { finish() },
          nfcTagEvents = _nfcTagEvents.asSharedFlow(),
          nfcStatusEvents = _nfcStatusState.asStateFlow(),
          onSetNfcLockMode = { locked, mode -> nfcController.setLockMode(locked, mode) },
          onGetNfcStatus = { nfcController.getStatusJson() },
          onOpenNfcSettings = { nfcController.openNfcSettings() },
          onVibrateFeedback = { ms -> nfcController.vibrateFeedback(ms) },
        )
      }
    }
  }

  override fun onResume() {
    super.onResume()
    if (::nfcController.isInitialized) {
      nfcController.onResume()
    }
  }

  override fun onPause() {
    if (::nfcController.isInitialized) {
      nfcController.onPause()
    }
    super.onPause()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    if (::nfcController.isInitialized) {
      nfcController.handleIntent(intent)
    }
  }

  private fun ensureWebViewCacheDirectories() {
    runCatching {
      val rootCache = applicationContext.cacheDir ?: return
      if (!rootCache.exists()) {
        rootCache.mkdirs()
      }
      val subDirs =
        listOf(
          "WebView/Default/HTTP Cache/Code Cache/js",
          "WebView/Default/HTTP Cache/Code Cache/wasm",
          "WebView/Default/HTTP Cache/Cache_Data",
        )
      subDirs.forEach { relPath ->
        val dir = File(rootCache, relPath)
        if (dir.exists() && !dir.isDirectory) {
          dir.delete()
        }
        if (!dir.exists()) {
          dir.mkdirs()
        }
      }
    }
  }
}
