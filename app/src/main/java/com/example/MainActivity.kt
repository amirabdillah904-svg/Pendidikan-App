package com.example

import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.example.pwa.PwaViewModel
import com.example.pwa.PwaWebViewScreen
import com.example.ui.theme.DeptPendidikanTheme
import java.io.File

class MainActivity : ComponentActivity() {

  private val viewModel: PwaViewModel by viewModels()

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    ensureWebViewCacheDirectories()
    enableEdgeToEdge()

    setContent {
      val uiState by viewModel.uiState.collectAsStateWithLifecycle()

      LaunchedEffect(uiState.isDarkTheme) {
        val barStyle =
          if (uiState.isDarkTheme) {
            SystemBarStyle.dark(Color.TRANSPARENT)
          } else {
            SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
          }
        enableEdgeToEdge(statusBarStyle = barStyle, navigationBarStyle = barStyle)
      }

      DeptPendidikanTheme(darkTheme = uiState.isDarkTheme) {
        PwaWebViewScreen(
          viewModel = viewModel,
          onExitApp = { finish() },
        )
      }
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
