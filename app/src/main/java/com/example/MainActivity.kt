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

class MainActivity : ComponentActivity() {

  private val viewModel: PwaViewModel by viewModels()

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
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
}
