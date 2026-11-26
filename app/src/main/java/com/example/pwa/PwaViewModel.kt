package com.example.pwa

import android.app.Application
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

sealed interface PwaUiEvent {
  data class FileExported(val result: ExportResult) : PwaUiEvent

  data class Message(val messageResId: Int) : PwaUiEvent
}

data class PwaUiState(
  val isLoading: Boolean = true,
  val loadProgress: Int = 0,
  val isOffline: Boolean = false,
  val isDarkTheme: Boolean = false,
  val hasLoadError: Boolean = false,
  val loadErrorMessage: String? = null,
)

class PwaViewModel(application: Application) : AndroidViewModel(application) {

  private val _uiState = MutableStateFlow(PwaUiState(isOffline = !isNetworkConnected(application)))
  val uiState: StateFlow<PwaUiState> = _uiState.asStateFlow()

  private val _events = MutableSharedFlow<PwaUiEvent>(extraBufferCapacity = 4)
  val events: SharedFlow<PwaUiEvent> = _events.asSharedFlow()

  private val connectivityManager =
    application.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager

  private val networkCallback =
    object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        _uiState.update { it.copy(isOffline = false) }
      }

      override fun onLost(network: Network) {
        _uiState.update { it.copy(isOffline = !isNetworkConnected(getApplication())) }
      }

      override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
        val online = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        _uiState.update { it.copy(isOffline = !online) }
      }
    }

  init {
    try {
      val request =
        NetworkRequest.Builder()
          .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
          .build()
      connectivityManager?.registerNetworkCallback(request, networkCallback)
    } catch (_: Exception) {
      // Gracefully ignore on restricted environments
    }
  }

  fun onProgressChanged(progress: Int) {
    _uiState.update {
      it.copy(
        loadProgress = progress,
        isLoading = progress in 1..99,
      )
    }
  }

  fun onPageStarted() {
    _uiState.update { it.copy(isLoading = true, hasLoadError = false, loadErrorMessage = null) }
  }

  fun onPageFinished() {
    _uiState.update { it.copy(isLoading = false, loadProgress = 100) }
  }

  fun onMainFrameError(description: String?) {
    _uiState.update {
      it.copy(
        isLoading = false,
        hasLoadError = true,
        loadErrorMessage = description,
      )
    }
  }

  fun onThemeChanged(isDark: Boolean) {
    _uiState.update { it.copy(isDarkTheme = isDark) }
  }

  fun exportBase64File(base64Data: String, fileName: String, mimeType: String) {
    viewModelScope.launch(Dispatchers.IO) {
      val result = PwaFileExporter.saveBase64File(getApplication(), base64Data, fileName, mimeType)
      _events.emit(PwaUiEvent.FileExported(result))
    }
  }

  fun emitMessage(messageResId: Int) {
    _events.tryEmit(PwaUiEvent.Message(messageResId))
  }

  override fun onCleared() {
    super.onCleared()
    try {
      connectivityManager?.unregisterNetworkCallback(networkCallback)
    } catch (_: Exception) {
      // Ignore if already unregistered
    }
  }

  private fun isNetworkConnected(context: Context): Boolean {
    val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return true
    val network = cm.activeNetwork ?: return false
    val caps = cm.getNetworkCapabilities(network) ?: return false
    return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
  }
}
