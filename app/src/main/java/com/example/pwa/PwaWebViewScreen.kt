package com.example.pwa

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.print.PrintAttributes
import android.print.PrintManager
import android.view.ViewGroup
import android.webkit.CookieManager
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CloudOff
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.WifiOff
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.example.R
import kotlinx.coroutines.launch

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun PwaWebViewScreen(
  viewModel: PwaViewModel,
  onExitApp: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val context = LocalContext.current
  val uiState by viewModel.uiState.collectAsStateWithLifecycle()
  val snackbarHostState = remember { SnackbarHostState() }
  val scope = rememberCoroutineScope()

  var webViewRef by remember { mutableStateOf<WebView?>(null) }
  var pendingFileCallback by remember { mutableStateOf<ValueCallback<Array<Uri>>?>(null) }
  var lastBackPressMs by remember { mutableLongStateOf(0L) }

  // Zero-permission Android Photo Picker for image uploads (Galeri, Logo, Banner, TTD)
  val photoPickerLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
      pendingFileCallback?.onReceiveValue(if (uri != null) arrayOf(uri) else null)
      pendingFileCallback = null
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
    }
  }

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
        visible = uiState.isOffline,
        enter = expandVertically() + fadeIn(),
        exit = shrinkVertically() + fadeOut(),
      ) {
        OfflineBanner(
          onRetry = { webViewRef?.reload() },
        )
      }

      AnimatedVisibility(
        visible = uiState.isLoading && uiState.loadProgress in 1..99,
        enter = fadeIn(),
        exit = fadeOut(),
      ) {
        LinearProgressIndicator(
          progress = { uiState.loadProgress / 100f },
          modifier = Modifier.fillMaxWidth().height(3.dp).testTag("pwa_loading_progress"),
          color = MaterialTheme.colorScheme.primary,
          trackColor = MaterialTheme.colorScheme.primaryContainer,
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

              settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
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
                    viewModel.onProgressChanged(newProgress)
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
}

private fun startNativePrint(context: Context, webView: WebView) {
  val printManager = context.getSystemService(Context.PRINT_SERVICE) as? PrintManager ?: return
  val jobName = context.getString(R.string.print_job_name)
  val adapter = webView.createPrintDocumentAdapter(jobName)
  printManager.print(jobName, adapter, PrintAttributes.Builder().build())
}

@Composable
private fun OfflineBanner(onRetry: () -> Unit) {
  Surface(
    color = MaterialTheme.colorScheme.errorContainer,
    contentColor = MaterialTheme.colorScheme.onErrorContainer,
    modifier = Modifier.fillMaxWidth().testTag("offline_banner"),
  ) {
    Row(
      modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      Icon(
        imageVector = Icons.Rounded.WifiOff,
        contentDescription = stringResource(R.string.content_desc_offline_icon),
        modifier = Modifier.size(18.dp),
      )
      Text(
        text = stringResource(R.string.offline_banner_message),
        style = MaterialTheme.typography.labelMedium,
        modifier = Modifier.weight(1f),
      )
      TextButton(
        onClick = onRetry,
        modifier = Modifier.testTag("offline_retry_button"),
      ) {
        Text(
          text = stringResource(R.string.retry_action),
          fontWeight = FontWeight.Bold,
        )
      }
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
