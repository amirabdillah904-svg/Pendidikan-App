package com.example.pwa

import android.app.Application
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.example.R
import com.example.offline.OfflineDatabase
import com.example.offline.OfflineSyncRepository
import com.example.offline.PendingSyncEntity
import com.example.offline.SyncNotificationHelper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking

sealed interface PwaUiEvent {
  data class FileExported(val result: ExportResult) : PwaUiEvent

  data class Message(val messageResId: Int) : PwaUiEvent

  data class SyncCompleted(val syncedCount: Int) : PwaUiEvent
}

data class PwaUiState(
  val isLoading: Boolean = true,
  val loadProgress: Int = 0,
  val isOffline: Boolean = false,
  val isDarkTheme: Boolean = true,
  val hasLoadError: Boolean = false,
  val loadErrorMessage: String? = null,
  val isSyncing: Boolean = false,
  val pendingCount: Int = 0,
  val pendingOperations: List<PendingSyncEntity> = emptyList(),
)

class PwaViewModel(application: Application) : AndroidViewModel(application) {

  private val repository =
    OfflineSyncRepository(OfflineDatabase.getInstance(application).offlineSyncDao())
  private val notificationHelper = SyncNotificationHelper(application)

  private val _uiState = MutableStateFlow(PwaUiState(isOffline = !isNetworkConnected(application)))
  val uiState: StateFlow<PwaUiState> = _uiState.asStateFlow()

  private val _events = MutableSharedFlow<PwaUiEvent>(extraBufferCapacity = 8)
  val events: SharedFlow<PwaUiEvent> = _events.asSharedFlow()

  private var autoSyncJob: Job? = null

  private val connectivityManager =
    application.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager

  private val networkCallback =
    object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        handleConnectivityChanged(online = true)
      }

      override fun onLost(network: Network) {
        handleConnectivityChanged(online = isNetworkConnected(getApplication()))
      }

      override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
        val online =
          capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        handleConnectivityChanged(online = online)
      }
    }

  init {
    viewModelScope.launch {
      repository.pendingOperations.collect { list ->
        _uiState.update { it.copy(pendingOperations = list, pendingCount = list.size) }
      }
    }

    try {
      val request =
        NetworkRequest.Builder()
          .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
          .build()
      connectivityManager?.registerNetworkCallback(request, networkCallback)
    } catch (_: Exception) {
      // Gracefully ignore on restricted environments
    }

    // Attempt initial sync if online and there are leftover pending items from previous session
    if (!_uiState.value.isOffline) {
      scheduleAutoSync(delayMs = 2000L)
    }
  }

  private fun handleConnectivityChanged(online: Boolean) {
    val wasOffline = _uiState.value.isOffline
    _uiState.update { it.copy(isOffline = !online) }
    if (online && (wasOffline || _uiState.value.pendingCount > 0)) {
      scheduleAutoSync(delayMs = 1500L)
    }
  }

  private fun scheduleAutoSync(delayMs: Long) {
    autoSyncJob?.cancel()
    autoSyncJob =
      viewModelScope.launch {
        delay(delayMs)
        if (!_uiState.value.isOffline && _uiState.value.pendingCount > 0) {
          syncPendingNow(silentIfEmpty = true)
        }
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

  fun enqueueOfflineWrite(
    clientOpId: String,
    fnName: String,
    argsJson: String,
    summaryLabel: String,
  ) {
    val cleanLabel = summaryLabel.ifBlank { OfflineSyncRepository.buildSummaryLabel(fnName, argsJson) }
    viewModelScope.launch {
      val count = repository.enqueueWrite(clientOpId, fnName, argsJson, cleanLabel)
      notificationHelper.notifyOfflineSaved(cleanLabel, count)
      _events.emit(PwaUiEvent.Message(R.string.snackbar_offline_saved))
      if (isNetworkConnected(getApplication())) {
        scheduleAutoSync(delayMs = 2500L)
      }
    }
  }

  fun cacheGasRead(cacheKey: String, fnName: String, responseJson: String) {
    viewModelScope.launch {
      repository.cacheReadResponse(cacheKey, fnName, responseJson)
    }
  }

  /**
   * Called strictly from WebView's background JavaBridge thread (never Android's main UI thread).
   */
  fun getCachedGasReadBlocking(cacheKey: String): String? {
    return runBlocking(Dispatchers.IO) { repository.getCachedResponse(cacheKey) }
  }

  fun notifyOnlineWriteSuccess(summaryLabel: String) {
    notificationHelper.notifyOnlineSaved(summaryLabel)
  }

  fun notifyRealtimeUpdate(title: String, body: String) {
    notificationHelper.notifyRealtimeUpdate(title, body)
  }

  fun deletePendingOperation(clientOpId: String) {
    viewModelScope.launch {
      repository.deletePendingOperation(clientOpId)
    }
  }

  fun syncPendingNow(silentIfEmpty: Boolean = false) {
    if (_uiState.value.isSyncing) return
    if (!isNetworkConnected(getApplication())) {
      _uiState.update { it.copy(isOffline = true) }
      if (!silentIfEmpty) emitMessage(R.string.snackbar_sync_failed)
      return
    }

    viewModelScope.launch {
      _uiState.update { it.copy(isSyncing = true, isOffline = false) }
      try {
        val result = repository.syncAllPending()
        if (result.attemptedCount == 0 && silentIfEmpty) {
          return@launch
        }
        when {
          result.syncedCount > 0 && result.failedCount == 0 -> {
            notificationHelper.notifySyncSuccess(result.syncedCount)
            _events.emit(PwaUiEvent.SyncCompleted(result.syncedCount))
          }
          result.syncedCount > 0 && result.failedCount > 0 -> {
            notificationHelper.notifySyncPartial(result.syncedCount, result.failedCount)
            _events.emit(PwaUiEvent.SyncCompleted(result.syncedCount))
          }
          result.failedCount > 0 -> {
            _events.emit(PwaUiEvent.Message(R.string.snackbar_sync_failed))
          }
        }
      } finally {
        _uiState.update { it.copy(isSyncing = false) }
      }
    }
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
    autoSyncJob?.cancel()
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
