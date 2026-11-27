package com.example.pwa

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.print.PrintAttributes
import android.print.PrintManager
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CloudDone
import androidx.compose.material.icons.rounded.CloudOff
import androidx.compose.material.icons.rounded.CloudSync
import androidx.compose.material.icons.rounded.DeleteOutline
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Sync
import androidx.compose.material.icons.rounded.WifiOff
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.example.R
import com.example.offline.PendingSyncEntity
import com.example.offline.SyncStatus
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun PwaWebViewScreen(
  viewModel: PwaViewModel,
  onExitApp: () -> Unit,
  modifier: Modifier = Modifier,
  nfcTagEvents: Flow<String> = emptyFlow(),
  nfcStatusEvents: Flow<String> = emptyFlow(),
  onSetNfcLockMode: (Boolean, String) -> Unit = { _, _ -> },
  onGetNfcStatus: () -> String = { "{\"supported\":false,\"enabled\":false,\"locked\":false,\"mode\":\"idle\"}" },
  onOpenNfcSettings: () -> Unit = {},
  onVibrateFeedback: (Long) -> Unit = {},
) {
  val context = LocalContext.current
  val uiState by viewModel.uiState.collectAsStateWithLifecycle()
  val snackbarHostState = remember { SnackbarHostState() }
  val scope = rememberCoroutineScope()

  var webViewRef by remember { mutableStateOf<WebView?>(null) }
  var pendingFileCallback by remember { mutableStateOf<ValueCallback<Array<Uri>>?>(null) }
  var pendingWebPermissionRequest by remember { mutableStateOf<PermissionRequest?>(null) }
  var lastBackPressMs by remember { mutableLongStateOf(0L) }
  var showQueueSheet by remember { mutableStateOf(false) }

  // Request Android 13+ notification permission gracefully for real-time sync alerts
  val notificationPermissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { _ -> }

  LaunchedEffect(Unit) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      val granted =
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
          PackageManager.PERMISSION_GRANTED
      if (!granted) {
        notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
      }
    }
  }

  // Zero-permission Android Photo Picker for image uploads (Galeri, Logo, Banner, TTD)
  val photoPickerLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
      pendingFileCallback?.onReceiveValue(if (uri != null) arrayOf(uri) else null)
      pendingFileCallback = null
    }

  // Runtime camera permission for live QR code scanning inside WebView
  val cameraPermissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      val req = pendingWebPermissionRequest
      pendingWebPermissionRequest = null
      if (req != null) {
        if (granted) {
          runCatching { req.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) }
        } else {
          runCatching { req.deny() }
        }
      }
      webViewRef?.evaluateJavascript(
        "if(window.__androidOnCameraPermissionResult){window.__androidOnCameraPermissionResult($granted);}",
        null,
      )
    }

  LaunchedEffect(nfcTagEvents, webViewRef) {
    nfcTagEvents.collect { payloadJson ->
      val safeJson = payloadJson.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "")
      webViewRef?.evaluateJavascript(
        "if(window.__androidOnNfcScanned){window.__androidOnNfcScanned('$safeJson');}",
        null,
      )
    }
  }

  LaunchedEffect(nfcStatusEvents, webViewRef) {
    nfcStatusEvents.collect { statusJson ->
      val safeJson = statusJson.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "")
      webViewRef?.evaluateJavascript(
        "if(window.__androidOnNfcStatusChanged){window.__androidOnNfcStatusChanged('$safeJson');}",
        null,
      )
    }
  }

  // Fallback document picker for non-image file inputs
  val genericFileLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
      pendingFileCallback?.onReceiveValue(if (uri != null) arrayOf(uri) else null)
      pendingFileCallback = null
    }

  LaunchedEffect(viewModel) {
    viewModel.events.collect { event ->
      when (event) {
        is PwaUiEvent.FileExported -> {
          val result = event.result
          if (result.isSuccess && result.uri != null) {
            val snackbarResult =
              snackbarHostState.showSnackbar(
                message = context.getString(R.string.download_saved_message, result.fileName),
                actionLabel = context.getString(R.string.action_open_file),
                duration = SnackbarDuration.Long,
              )
            if (snackbarResult == SnackbarResult.ActionPerformed) {
              PwaFileExporter.openOrShareDocument(context, result.uri, result.mimeType)
            }
          } else {
            snackbarHostState.showSnackbar(
              message =
                context.getString(
                  R.string.download_failed_message,
                  result.errorMessage ?: result.fileName,
                ),
              duration = SnackbarDuration.Short,
            )
          }
        }
        is PwaUiEvent.SyncCompleted -> {
          webViewRef?.evaluateJavascript(
            "if(window.__androidOnSyncCompleted){window.__androidOnSyncCompleted(${event.syncedCount});}",
            null,
          )
          snackbarHostState.showSnackbar(
            message = context.getString(R.string.snackbar_sync_done, event.syncedCount),
            duration = SnackbarDuration.Short,
          )
        }
        is PwaUiEvent.Message -> {
          snackbarHostState.showSnackbar(
            message = context.getString(event.messageResId),
            duration = SnackbarDuration.Short,
          )
        }
      }
    }
  }

  BackHandler(enabled = true) {
    if (showQueueSheet) {
      showQueueSheet = false
      return@BackHandler
    }
    val wv = webViewRef
    if (wv == null) {
      onExitApp()
      return@BackHandler
    }
    wv.evaluateJavascript("window.__androidHandleBack ? window.__androidHandleBack() : 'exit'") { rawResult ->
      val result = rawResult?.trim('"')
      if (result == "handled") return@evaluateJavascript

      if (wv.canGoBack()) {
        wv.goBack()
        return@evaluateJavascript
      }

      val now = System.currentTimeMillis()
      if (now - lastBackPressMs < 2000L) {
        onExitApp()
      } else {
        lastBackPressMs = now
        scope.launch {
          snackbarHostState.showSnackbar(
            message = context.getString(R.string.press_back_again_to_exit),
            duration = SnackbarDuration.Short,
          )
        }
      }
    }
  }

  DisposableEffect(Unit) {
    onDispose {
      pendingFileCallback?.onReceiveValue(null)
      pendingFileCallback = null
      pendingWebPermissionRequest?.deny()
      pendingWebPermissionRequest = null
    }
  }

  val showStatusBanner = uiState.isOffline || uiState.isSyncing || uiState.pendingCount > 0

  Scaffold(
    modifier = modifier.fillMaxSize().background(MaterialTheme.colorScheme.background),
    containerColor = MaterialTheme.colorScheme.background,
    contentWindowInsets = WindowInsets(0, 0, 0, 0),
    snackbarHost = {
      SnackbarHost(
        hostState = snackbarHostState,
        modifier = Modifier.navigationBarsPadding().padding(bottom = 12.dp),
      )
    },
  ) { innerPadding ->
    Column(
      modifier =
        Modifier
          .fillMaxSize()
          .padding(innerPadding)
          .statusBarsPadding()
          .navigationBarsPadding()
          .imePadding()
    ) {
      AnimatedVisibility(
        visible = showStatusBanner,
        enter = expandVertically() + fadeIn(),
        exit = shrinkVertically() + fadeOut(),
      ) {
        OfflineSyncBanner(
          isOffline = uiState.isOffline,
          isSyncing = uiState.isSyncing,
          pendingCount = uiState.pendingCount,
          onSyncNow = { viewModel.syncPendingNow() },
          onOpenQueue = { showQueueSheet = true },
        )
      }

      Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
        AndroidView(
          modifier = Modifier.fillMaxSize().testTag("pwa_webview"),
          factory = { ctx ->
            WebView(ctx).apply {
              layoutParams =
                ViewGroup.LayoutParams(
                  ViewGroup.LayoutParams.MATCH_PARENT,
                  ViewGroup.LayoutParams.MATCH_PARENT,
                )
              setBackgroundColor(android.graphics.Color.TRANSPARENT)
              overScrollMode = android.view.View.OVER_SCROLL_NEVER
              isVerticalScrollBarEnabled = false
              isHorizontalScrollBarEnabled = false

              settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                allowFileAccess = false
                allowContentAccess = true
                loadsImagesAutomatically = true
                useWideViewPort = true
                loadWithOverviewMode = true
                setSupportZoom(false)
                builtInZoomControls = false
                displayZoomControls = false
                mediaPlaybackRequiresUserGesture = false
                javaScriptCanOpenWindowsAutomatically = true
                mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
                cacheMode = WebSettings.LOAD_DEFAULT
              }

              val currentWebView = this
              CookieManager.getInstance().apply {
                setAcceptCookie(true)
                setAcceptThirdPartyCookies(currentWebView, true)
              }

              val jsBridge =
                PwaJsBridge(
                  context = ctx,
                  onSaveFile = { base64, name, mime ->
                    viewModel.exportBase64File(base64, name, mime)
                  },
                  onPrintRequested = {
                    post { startNativePrint(ctx, this) }
                  },
                  onThemeChangedCallback = { isDark ->
                    post { viewModel.onThemeChanged(isDark) }
                  },
                  onClipboardCopied = {
                    viewModel.emitMessage(R.string.copied_to_clipboard)
                  },
                  onExternalLinkFailed = {
                    viewModel.emitMessage(R.string.open_external_error)
                  },
                  onEnqueueOfflineWrite = { clientOpId, fnName, argsJson, label ->
                    viewModel.enqueueOfflineWrite(clientOpId, fnName, argsJson, label)
                  },
                  onCacheGasRead = { cacheKey, fnName, responseJson ->
                    viewModel.cacheGasRead(cacheKey, fnName, responseJson)
                  },
                  onReadGasCacheSync = { cacheKey ->
                    viewModel.getCachedGasReadBlocking(cacheKey)
                  },
                  onOnlineWriteSucceeded = { label ->
                    viewModel.notifyOnlineWriteSuccess(label)
                  },
                  onRealtimeNotification = { title, body ->
                    viewModel.notifyRealtimeUpdate(title, body)
                  },
                  onManualSyncRequested = {
                    viewModel.syncPendingNow()
                  },
                  onSetNfcLockMode = { locked, mode ->
                    onSetNfcLockMode(locked, mode)
                  },
                  onGetNfcStatus = {
                    onGetNfcStatus()
                  },
                  onOpenNfcSettings = {
                    post { onOpenNfcSettings() }
                  },
                  onRequestCameraPermission = {
                    post {
                      val granted =
                        ContextCompat.checkSelfPermission(ctx, Manifest.permission.CAMERA) ==
                          PackageManager.PERMISSION_GRANTED
                      if (granted) {
                        webViewRef?.evaluateJavascript(
                          "if(window.__androidOnCameraPermissionResult){window.__androidOnCameraPermissionResult(true);}",
                          null,
                        )
                      } else {
                        cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
                      }
                    }
                  },
                  onVibrateFeedback = { ms ->
                    onVibrateFeedback(ms)
                  },
                )
              addJavascriptInterface(jsBridge, PwaJsBridge.BRIDGE_NAME)

              webViewClient =
                object : WebViewClient() {
                  override fun shouldInterceptRequest(
                    view: WebView?,
                    request: WebResourceRequest?,
                  ): WebResourceResponse? {
                    return PwaAssetInterceptor.intercept(ctx, request?.url)
                  }

                  override fun shouldOverrideUrlLoading(
                    view: WebView?,
                    request: WebResourceRequest?,
                  ): Boolean {
                    val uri = request?.url ?: return false
                    if (PwaAssetInterceptor.isLocalAppUri(uri)) {
                      return false
                    }
                    val host = uri.host?.lowercase().orEmpty()
                    val scheme = uri.scheme?.lowercase().orEmpty()
                    val shouldOpenExternally =
                      scheme in setOf("whatsapp", "tel", "mailto", "intent") ||
                        host.contains("whatsapp.com") ||
                        host == "wa.me"

                    if (shouldOpenExternally) {
                      try {
                        ctx.startActivity(
                          Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        )
                      } catch (_: Exception) {
                        viewModel.emitMessage(R.string.open_external_error)
                      }
                      return true
                    }
                    return false
                  }

                  override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                    viewModel.onPageStarted()
                  }

                  override fun onPageFinished(view: WebView?, url: String?) {
                    view?.evaluateJavascript(PwaJsBridge.BRIDGE_INJECTION_JS, null)
                    viewModel.onPageFinished()
                  }

                  override fun onReceivedError(
                    view: WebView?,
                    request: WebResourceRequest?,
                    error: WebResourceError?,
                  ) {
                    if (request?.isForMainFrame == true) {
                      viewModel.onMainFrameError(error?.description?.toString())
                    }
                  }
                }

              webChromeClient =
                object : WebChromeClient() {
                  override fun onProgressChanged(view: WebView?, newProgress: Int) {
                    if (newProgress >= 100) {
                      viewModel.onProgressChanged(100)
                    }
                  }

                  override fun onPermissionRequest(request: PermissionRequest?) {
                    if (request == null) return
                    val originHost = request.origin?.host?.lowercase().orEmpty()
                    val wantsVideo = request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)
                    if (!wantsVideo || originHost != PwaAssetInterceptor.APP_HOST) {
                      request.deny()
                      return
                    }
                    val granted =
                      ContextCompat.checkSelfPermission(ctx, Manifest.permission.CAMERA) ==
                        PackageManager.PERMISSION_GRANTED
                    if (granted) {
                      request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                    } else {
                      pendingWebPermissionRequest?.deny()
                      pendingWebPermissionRequest = request
                      cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
                    }
                  }

                  override fun onShowFileChooser(
                    webView: WebView?,
                    filePathCallback: ValueCallback<Array<Uri>>?,
                    fileChooserParams: FileChooserParams?,
                  ): Boolean {
                    pendingFileCallback?.onReceiveValue(null)
                    pendingFileCallback = filePathCallback

                    val acceptTypes = fileChooserParams?.acceptTypes.orEmpty()
                    val wantsImagesOnly =
                      acceptTypes.isEmpty() ||
                        acceptTypes.all { it.isBlank() || it.startsWith("image/") }

                    return try {
                      if (wantsImagesOnly) {
                        photoPickerLauncher.launch(
                          PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                        )
                      } else {
                        genericFileLauncher.launch(acceptTypes.firstOrNull { it.isNotBlank() } ?: "*/*")
                      }
                      true
                    } catch (_: Exception) {
                      pendingFileCallback?.onReceiveValue(null)
                      pendingFileCallback = null
                      false
                    }
                  }
                }

              setDownloadListener { url, _, contentDisposition, mimeType, _ ->
                val guessedName = URLUtil.guessFileName(url, contentDisposition, mimeType)
                if (url.startsWith("blob:")) {
                  val safeUrl = url.replace("'", "\\'")
                  val safeName = guessedName.replace("'", "\\'")
                  val safeMime = mimeType.replace("'", "\\'")
                  evaluateJavascript(
                    "if(window.__androidRelayBlob){window.__androidRelayBlob('$safeUrl','$safeName','$safeMime');}",
                    null,
                  )
                } else if (url.startsWith("data:")) {
                  viewModel.exportBase64File(url, guessedName, mimeType)
                } else {
                  try {
                    ctx.startActivity(
                      Intent(Intent.ACTION_VIEW, Uri.parse(url))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    )
                  } catch (_: Exception) {
                    viewModel.emitMessage(R.string.open_external_error)
                  }
                }
              }

              webViewRef = this
              loadUrl(PwaAssetInterceptor.ENTRY_URL)
            }
          },
          update = { webViewRef = it },
        )

        if (uiState.hasLoadError) {
          ErrorFallbackOverlay(
            onRetry = {
              webViewRef?.loadUrl(PwaAssetInterceptor.ENTRY_URL)
            },
          )
        }
      }
    }
  }

  if (showQueueSheet) {
    OfflineQueueBottomSheet(
      operations = uiState.pendingOperations,
      isOffline = uiState.isOffline,
      isSyncing = uiState.isSyncing,
      onSyncNow = { viewModel.syncPendingNow() },
      onDeleteItem = { viewModel.deletePendingOperation(it) },
      onDismiss = { showQueueSheet = false },
    )
  }
}

private fun startNativePrint(context: Context, webView: WebView) {
  val printManager = context.getSystemService(Context.PRINT_SERVICE) as? PrintManager ?: return
  val jobName = context.getString(R.string.print_job_name)
  val adapter = webView.createPrintDocumentAdapter(jobName)
  printManager.print(jobName, adapter, PrintAttributes.Builder().build())
}

@Composable
private fun OfflineSyncBanner(
  isOffline: Boolean,
  isSyncing: Boolean,
  pendingCount: Int,
  onSyncNow: () -> Unit,
  onOpenQueue: () -> Unit,
) {
  val containerColor =
    when {
      isOffline -> MaterialTheme.colorScheme.errorContainer
      else -> MaterialTheme.colorScheme.primaryContainer
    }
  val contentColor =
    when {
      isOffline -> MaterialTheme.colorScheme.onErrorContainer
      else -> MaterialTheme.colorScheme.onPrimaryContainer
    }

  val message =
    when {
      isSyncing -> stringResource(R.string.syncing_banner_message, pendingCount.coerceAtLeast(1))
      isOffline && pendingCount > 0 -> stringResource(R.string.offline_pending_banner_message, pendingCount)
      isOffline -> stringResource(R.string.offline_banner_message)
      else -> stringResource(R.string.online_pending_banner_message, pendingCount)
    }

  Surface(
    color = containerColor,
    contentColor = contentColor,
    modifier = Modifier.fillMaxWidth().testTag("offline_sync_banner"),
  ) {
    Row(
      modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      if (isSyncing) {
        CircularProgressIndicator(
          modifier = Modifier.size(16.dp),
          strokeWidth = 2.dp,
          color = contentColor,
        )
      } else {
        Icon(
          imageVector = if (isOffline) Icons.Rounded.WifiOff else Icons.Rounded.CloudSync,
          contentDescription =
            stringResource(
              if (isOffline) R.string.content_desc_offline_icon else R.string.content_desc_sync_icon
            ),
          modifier = Modifier.size(18.dp),
        )
      }
      Text(
        text = message,
        style = MaterialTheme.typography.labelMedium,
        modifier = Modifier.weight(1f),
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
      )
      if (pendingCount > 0) {
        TextButton(
          onClick = onOpenQueue,
          modifier = Modifier.testTag("open_sync_queue_button"),
        ) {
          Text(
            text = stringResource(R.string.action_view_queue),
            fontWeight = FontWeight.Bold,
          )
        }
      }
      if (!isOffline && !isSyncing && pendingCount > 0) {
        TextButton(
          onClick = onSyncNow,
          modifier = Modifier.testTag("sync_now_button"),
        ) {
          Text(
            text = stringResource(R.string.action_sync_now),
            fontWeight = FontWeight.Bold,
          )
        }
      }
    }
  }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun OfflineQueueBottomSheet(
  operations: List<PendingSyncEntity>,
  isOffline: Boolean,
  isSyncing: Boolean,
  onSyncNow: () -> Unit,
  onDeleteItem: (String) -> Unit,
  onDismiss: () -> Unit,
) {
  val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
  val formatter = remember { SimpleDateFormat("dd MMM HH:mm", Locale.getDefault()) }

  ModalBottomSheet(
    onDismissRequest = onDismiss,
    sheetState = sheetState,
    containerColor = MaterialTheme.colorScheme.surface,
  ) {
    Column(
      modifier =
        Modifier
          .fillMaxWidth()
          .navigationBarsPadding()
          .padding(horizontal = 20.dp, vertical = 8.dp),
      verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
      ) {
        Column(modifier = Modifier.weight(1f)) {
          Text(
            text = stringResource(R.string.queue_sheet_title),
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
          )
          Text(
            text = stringResource(R.string.queue_sheet_subtitle),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
          )
        }
        if (operations.isNotEmpty()) {
          Button(
            onClick = onSyncNow,
            enabled = !isOffline && !isSyncing,
            shape = RoundedCornerShape(12.dp),
            modifier = Modifier.testTag("sheet_sync_now_button"),
          ) {
            Icon(
              imageVector = Icons.Rounded.Sync,
              contentDescription = null,
              modifier = Modifier.size(16.dp),
            )
            Spacer(modifier = Modifier.size(6.dp))
            Text(text = stringResource(R.string.action_sync_now))
          }
        }
      }

      if (operations.isEmpty()) {
        Row(
          modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp),
          horizontalArrangement = Arrangement.Center,
          verticalAlignment = Alignment.CenterVertically,
        ) {
          Icon(
            imageVector = Icons.Rounded.CloudDone,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.secondary,
            modifier = Modifier.size(24.dp),
          )
          Spacer(modifier = Modifier.size(8.dp))
          Text(
            text = stringResource(R.string.queue_empty_message),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
          )
        }
      } else {
        LazyColumn(
          modifier = Modifier.fillMaxWidth().height(260.dp),
          verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
          items(operations, key = { it.clientOpId }) { item ->
            val statusLabel =
              when (item.status) {
                SyncStatus.SYNCING -> stringResource(R.string.queue_status_syncing)
                SyncStatus.FAILED -> stringResource(R.string.queue_status_failed)
                else -> stringResource(R.string.queue_status_pending)
              }
            Card(
              shape = RoundedCornerShape(14.dp),
              colors =
                CardDefaults.cardColors(
                  containerColor = MaterialTheme.colorScheme.background,
                ),
            ) {
              Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
              ) {
                Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                  Text(
                    text = item.summaryLabel,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                  )
                  Text(
                    text = "${formatter.format(Date(item.createdAt))} • $statusLabel",
                    style = MaterialTheme.typography.labelSmall,
                    color =
                      if (item.status == SyncStatus.FAILED) {
                        MaterialTheme.colorScheme.error
                      } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                      },
                  )
                  if (!item.lastError.isNullOrBlank()) {
                    Text(
                      text = item.lastError,
                      style = MaterialTheme.typography.labelSmall,
                      color = MaterialTheme.colorScheme.error,
                      maxLines = 1,
                      overflow = TextOverflow.Ellipsis,
                    )
                  }
                }
                IconButton(
                  onClick = { onDeleteItem(item.clientOpId) },
                  modifier = Modifier.testTag("delete_queue_item_${item.clientOpId}"),
                ) {
                  Icon(
                    imageVector = Icons.Rounded.DeleteOutline,
                    contentDescription = stringResource(R.string.content_desc_delete_queue_item),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                  )
                }
              }
            }
          }
        }
      }
      Spacer(modifier = Modifier.height(12.dp))
    }
  }
}

@Composable
private fun ErrorFallbackOverlay(onRetry: () -> Unit) {
  Box(
    modifier =
      Modifier
        .fillMaxSize()
        .background(MaterialTheme.colorScheme.background)
        .padding(24.dp),
    contentAlignment = Alignment.Center,
  ) {
    Card(
      shape = RoundedCornerShape(24.dp),
      colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
      elevation = CardDefaults.cardElevation(defaultElevation = 2.dp),
      modifier = Modifier.fillMaxWidth().widthIn(max = 420.dp),
    ) {
      Column(
        modifier = Modifier.fillMaxWidth().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
      ) {
        Icon(
          imageVector = Icons.Rounded.CloudOff,
          contentDescription = stringResource(R.string.content_desc_error_icon),
          tint = MaterialTheme.colorScheme.primary,
          modifier = Modifier.size(48.dp),
        )
        Text(
          text = stringResource(R.string.error_load_title),
          style = MaterialTheme.typography.titleMedium,
          fontWeight = FontWeight.Bold,
          textAlign = TextAlign.Center,
        )
        Text(
          text = stringResource(R.string.error_load_subtitle),
          style = MaterialTheme.typography.bodyMedium,
          color = MaterialTheme.colorScheme.onSurfaceVariant,
          textAlign = TextAlign.Center,
        )
        Spacer(modifier = Modifier.height(4.dp))
        Button(
          onClick = onRetry,
          shape = RoundedCornerShape(14.dp),
          modifier = Modifier.testTag("error_retry_button"),
        ) {
          Icon(
            imageVector = Icons.Rounded.Refresh,
            contentDescription = null,
            modifier = Modifier.size(18.dp),
          )
          Spacer(modifier = Modifier.size(8.dp))
          Text(text = stringResource(R.string.retry_action))
        }
      }
    }
  }
}
