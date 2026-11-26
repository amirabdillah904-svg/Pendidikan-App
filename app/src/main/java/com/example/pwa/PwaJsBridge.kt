package com.example.pwa

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.JavascriptInterface

/**
 * Native bridge exposed to the PWA as `window.AndroidBridge` to support file exports,
 * system print, external apps (WhatsApp), clipboard, theme sync, and back navigation.
 */
class PwaJsBridge(
  private val context: Context,
  private val onSaveFile: (base64: String, fileName: String, mimeType: String) -> Unit,
  private val onPrintRequested: () -> Unit,
  private val onThemeChangedCallback: (isDark: Boolean) -> Unit,
  private val onClipboardCopied: () -> Unit,
  private val onExternalLinkFailed: () -> Unit,
) {

  @JavascriptInterface
  fun saveBase64File(base64Data: String, fileName: String, mimeType: String) {
    onSaveFile(base64Data, fileName, mimeType)
  }

  @JavascriptInterface
  fun printPage() {
    onPrintRequested()
  }

  @JavascriptInterface
  fun onThemeChanged(isDark: Boolean) {
    onThemeChangedCallback(isDark)
  }

  @JavascriptInterface
  fun copyToClipboard(text: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
    clipboard?.setPrimaryClip(ClipData.newPlainText("DeptPendidikan", text))
    onClipboardCopied()
  }

  @JavascriptInterface
  fun openExternalUrl(url: String) {
    val parsed = Uri.parse(url)
    val scheme = parsed.scheme?.lowercase()
    if (scheme !in ALLOWED_EXTERNAL_SCHEMES) return
    try {
      val intent =
        Intent(Intent.ACTION_VIEW, parsed).apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
      context.startActivity(intent)
    } catch (_: Exception) {
      onExternalLinkFailed()
    }
  }

  companion object {
    const val BRIDGE_NAME = "AndroidBridge"
    private val ALLOWED_EXTERNAL_SCHEMES = setOf("https", "http", "whatsapp", "mailto", "tel")

    /**
     * Lightweight, idempotent script injected into the WebView once the PWA loads.
     */
    val BRIDGE_INJECTION_JS =
      """
      (function() {
        if (window.__androidPwaBridgeInstalled) return;
        window.__androidPwaBridgeInstalled = true;

        function notifyTheme() {
          try {
            if (window.AndroidBridge) {
              window.AndroidBridge.onThemeChanged(document.documentElement.classList.contains('dark'));
            }
          } catch (e) {}
        }
        notifyTheme();

        try {
          new MutationObserver(notifyTheme).observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['class']
          });
        } catch (e) {}

        window.print = function() {
          if (window.AndroidBridge && typeof window.AndroidBridge.printPage === 'function') {
            window.AndroidBridge.printPage();
          }
        };

        var origOpen = window.open;
        window.open = function(url, target, features) {
          if (typeof url === 'string' && /^(https?:|whatsapp:|mailto:|tel:)/i.test(url)) {
            if (window.AndroidBridge && typeof window.AndroidBridge.openExternalUrl === 'function') {
              window.AndroidBridge.openExternalUrl(url);
              return null;
            }
          }
          return origOpen ? origOpen.call(window, url, target, features) : null;
        };

        function relayBlobToAndroid(blobUrl, fileName, fallbackMime) {
          fetch(blobUrl)
            .then(function(r) { return r.blob(); })
            .then(function(blob) {
              var reader = new FileReader();
              reader.onloadend = function() {
                if (window.AndroidBridge && typeof window.AndroidBridge.saveBase64File === 'function') {
                  var mime = blob.type || fallbackMime || 'application/octet-stream';
                  window.AndroidBridge.saveBase64File(String(reader.result || ''), fileName || 'dokumen', mime);
                }
              };
              reader.readAsDataURL(blob);
            })
            .catch(function(err) { console.warn('Android blob export error:', err); });
        }

        window.__androidRelayBlob = relayBlobToAndroid;

        var origAnchorClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function() {
          try {
            var href = this.getAttribute('href') || this.href || '';
            var dl = this.getAttribute('download') || this.download || '';
            if (href.indexOf('blob:') === 0 && window.AndroidBridge) {
              var guessMime = dl.toLowerCase().endsWith('.pdf')
                ? 'application/pdf'
                : dl.toLowerCase().endsWith('.csv')
                  ? 'text/csv'
                  : 'application/octet-stream';
              relayBlobToAndroid(href, dl || 'Dokumen_DeptPendidikan', guessMime);
              return;
            }
          } catch (e) {}
          return origAnchorClick.apply(this, arguments);
        };

        if (typeof window.copyWaReport === 'function') {
          var origCopyWa = window.copyWaReport;
          window.copyWaReport = function() {
            var el = document.getElementById('waPreviewText');
            if (el && window.AndroidBridge && typeof window.AndroidBridge.copyToClipboard === 'function') {
              window.AndroidBridge.copyToClipboard(el.value || '');
            }
            return origCopyWa.apply(this, arguments);
          };
        }

        window.__androidHandleBack = function() {
          try {
            if (typeof Swal !== 'undefined' && typeof Swal.isVisible === 'function' && Swal.isVisible()) {
              Swal.close();
              return 'handled';
            }
            var openModal = document.querySelector('.modal-backdrop-clean.modal-is-open');
            if (openModal && openModal.id && typeof closeModal === 'function') {
              closeModal(openModal.id);
              return 'handled';
            }
            var sidebar = document.getElementById('appSidebar');
            if (sidebar && !sidebar.classList.contains('-translate-x-full') && window.innerWidth < 768 && typeof closeSidebar === 'function') {
              closeSidebar();
              return 'handled';
            }
            var appCont = document.getElementById('appContainer');
            var homeTab = document.getElementById('tab-home');
            if (appCont && !appCont.classList.contains('hidden') && homeTab && homeTab.classList.contains('hidden') && typeof switchTab === 'function') {
              switchTab('home');
              return 'handled';
            }
          } catch (e) {}
          return 'exit';
        };
      })();
      """.trimIndent()
  }
}
