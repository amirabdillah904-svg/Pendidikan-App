package com.example.pwa

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.JavascriptInterface

/**
 * Native bridge exposed to the PWA as `window.AndroidBridge` to support Offline-First Room
 * storage, Google Sheet auto-sync, real-time notifications, file exports, printing,
 * external apps (WhatsApp), clipboard, theme sync, and back navigation.
 */
class PwaJsBridge(
  private val context: Context,
  private val onSaveFile: (base64: String, fileName: String, mimeType: String) -> Unit,
  private val onPrintRequested: () -> Unit,
  private val onThemeChangedCallback: (isDark: Boolean) -> Unit,
  private val onClipboardCopied: () -> Unit,
  private val onExternalLinkFailed: () -> Unit,
  private val onEnqueueOfflineWrite: (clientOpId: String, fnName: String, argsJson: String, summaryLabel: String) -> Unit,
  private val onCacheGasRead: (cacheKey: String, fnName: String, responseJson: String) -> Unit,
  private val onReadGasCacheSync: (cacheKey: String) -> String?,
  private val onOnlineWriteSucceeded: (summaryLabel: String) -> Unit,
  private val onRealtimeNotification: (title: String, body: String) -> Unit,
  private val onManualSyncRequested: () -> Unit,
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

  @JavascriptInterface
  fun enqueueOfflineWrite(
    clientOpId: String,
    fnName: String,
    argsJson: String,
    summaryLabel: String,
  ) {
    onEnqueueOfflineWrite(clientOpId, fnName, argsJson, summaryLabel)
  }

  @JavascriptInterface
  fun cacheGasRead(cacheKey: String, fnName: String, responseJson: String) {
    onCacheGasRead(cacheKey, fnName, responseJson)
  }

  @JavascriptInterface
  fun getCachedGasRead(cacheKey: String): String {
    return onReadGasCacheSync(cacheKey).orEmpty()
  }

  @JavascriptInterface
  fun notifyOnlineWriteSuccess(summaryLabel: String) {
    onOnlineWriteSucceeded(summaryLabel)
  }

  @JavascriptInterface
  fun notifyRealtimeEvent(title: String, body: String) {
    onRealtimeNotification(title, body)
  }

  @JavascriptInterface
  fun requestManualSync() {
    onManualSyncRequested()
  }

  companion object {
    const val BRIDGE_NAME = "AndroidBridge"
    private val ALLOWED_EXTERNAL_SCHEMES = setOf("https", "http", "whatsapp", "mailto", "tel")

    /**
     * Lightweight, idempotent script injected into the WebView once the PWA loads.
     * Adds Offline-First Room caching & write queueing on top of `window.google.script.run`.
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

        // === OFFLINE-FIRST & REAL-TIME SYNC INTERCEPTOR ===
        var READ_FNS = [
          'getFastLoginData', 'getInitialBundle', 'getRekapData', 'getMissingAttendance',
          'getFinancialData', 'getUsersData', 'getPengumuman', 'getGaleriData',
          'getSaran', 'getSurat', 'getDbData'
        ];
        var WRITE_FNS = [
          'submitAbsensi', 'saveFinancialData', 'deleteFinancialData',
          'savePengumuman', 'deletePengumuman', 'saveGaleriData', 'deleteGaleriData',
          'toggleGaleriLike', 'saveSaran', 'deleteSaran', 'saveSuratData', 'deleteSurat',
          'saveDbData', 'deleteDbData', 'saveUserData', 'deleteUserData', 'updateAppSettings'
        ];

        function genClientOpId() {
          return 'op_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
        }

        function describeWrite(fnName, args) {
          var first = (args && args.length > 0 && args[0] && typeof args[0] === 'object') ? args[0] : null;
          if (fnName === 'submitAbsensi' && first) {
            return 'Absensi ' + String(first.type || '').toUpperCase() + ' • ' + String(first.target || '');
          }
          if (fnName === 'saveFinancialData' && first) {
            return 'Dana ' + String((args && args[1]) || 'Keuangan') + ' • ' + String(first.keterangan || '');
          }
          if (fnName === 'savePengumuman') return 'Pengumuman Baru';
          if (fnName === 'saveGaleriData') return 'Foto Galeri Kegiatan';
          if (fnName === 'saveSaran') return 'Kotak Saran';
          if (fnName === 'saveSuratData' && first) return 'Arsip Surat • ' + String(first.perihal || '');
          if (fnName === 'saveDbData') return 'Database (' + String((args && args[0]) || '') + ')';
          if (fnName === 'saveUserData') return 'Data User';
          if (fnName === 'updateAppSettings') return 'Setelan Aplikasi';
          return 'Data ' + fnName;
        }

        function checkRealtimeAnnouncement(data) {
          try {
            var list = data && Array.isArray(data.pengumuman) ? data.pengumuman : null;
            if (!list || !list.length) return;
            var latest = list[0];
            var latestId = String(latest.id || latest.tanggal + '_' + latest.isi);
            var prevId = localStorage.getItem('alrifaie_last_seen_pengumuman_id');
            if (prevId && prevId !== latestId && window.AndroidBridge) {
              window.AndroidBridge.notifyRealtimeEvent(
                'Informasi Terbaru • Dept. Pendidikan',
                String(latest.isi || 'Ada pengumuman baru.')
              );
            }
            localStorage.setItem('alrifaie_last_seen_pengumuman_id', latestId);
          } catch (e) {}
        }

        if (window.google && window.google.script && window.google.script.run && !window.__androidGasOfflineWrapped) {
          window.__androidGasOfflineWrapped = true;
          var rawGasRun = window.google.script.run;

          function wrapGasChain(onSuccess, onFailure) {
            return new Proxy({}, {
              get: function(_, prop) {
                if (prop === 'withSuccessHandler') return function(fn) { return wrapGasChain(fn, onFailure); };
                if (prop === 'withFailureHandler') return function(fn) { return wrapGasChain(onSuccess, fn); };

                return function() {
                  var args = Array.prototype.slice.call(arguments);
                  var fnName = String(prop);
                  var isRead = READ_FNS.indexOf(fnName) !== -1;
                  var isWrite = WRITE_FNS.indexOf(fnName) !== -1;

                  if (isRead) {
                    var cacheKey = fnName + '|' + JSON.stringify(args || []);
                    var tryServeCache = function() {
                      try {
                        if (window.AndroidBridge && typeof window.AndroidBridge.getCachedGasRead === 'function') {
                          var cachedStr = window.AndroidBridge.getCachedGasRead(cacheKey);
                          if (cachedStr) {
                            var parsed = JSON.parse(cachedStr);
                            if (typeof onSuccess === 'function') onSuccess(parsed);
                            return true;
                          }
                        }
                      } catch (e) {}
                      return false;
                    };

                    if (!navigator.onLine && tryServeCache()) {
                      return;
                    }

                    rawGasRun
                      .withSuccessHandler(function(res) {
                        try {
                          if (window.AndroidBridge && typeof window.AndroidBridge.cacheGasRead === 'function') {
                            window.AndroidBridge.cacheGasRead(cacheKey, fnName, JSON.stringify(res));
                          }
                          if (fnName === 'getFastLoginData' || fnName === 'getInitialBundle') {
                            checkRealtimeAnnouncement(res);
                          }
                        } catch (e) {}
                        if (typeof onSuccess === 'function') onSuccess(res);
                      })
                      .withFailureHandler(function(err) {
                        if (!tryServeCache() && typeof onFailure === 'function') {
                          onFailure(err);
                        }
                      })[fnName].apply(null, args);
                    return;
                  }

                  if (isWrite) {
                    var opId = genClientOpId();
                    var label = describeWrite(fnName, args);
                    var queueLocally = function() {
                      try {
                        if (window.AndroidBridge && typeof window.AndroidBridge.enqueueOfflineWrite === 'function') {
                          window.AndroidBridge.enqueueOfflineWrite(opId, fnName, JSON.stringify(args), label);
                        }
                      } catch (e) {}
                      if (typeof onSuccess === 'function') {
                        onSuccess({
                          success: true,
                          offlineQueued: true,
                          clientOpId: opId,
                          message: 'Disimpan secara lokal (Offline). Akan disinkronkan otomatis ke Google Sheet saat koneksi stabil.'
                        });
                      }
                    };

                    if (!navigator.onLine) {
                      queueLocally();
                      return;
                    }

                    rawGasRun
                      .withSuccessHandler(function(res) {
                        try {
                          if (window.AndroidBridge && typeof window.AndroidBridge.notifyOnlineWriteSuccess === 'function') {
                            if (fnName === 'submitAbsensi' || fnName === 'saveFinancialData' || fnName === 'savePengumuman' || fnName === 'saveSuratData') {
                              window.AndroidBridge.notifyOnlineWriteSuccess(label);
                            }
                          }
                        } catch (e) {}
                        if (typeof onSuccess === 'function') onSuccess(res);
                      })
                      .withFailureHandler(function() {
                        queueLocally();
                      })[fnName].apply(null, args);
                    return;
                  }

                  // Auth & other calls run directly
                  rawGasRun
                    .withSuccessHandler(function(res) {
                      if (typeof onSuccess === 'function') onSuccess(res);
                    })
                    .withFailureHandler(function(err) {
                      if (typeof onFailure === 'function') onFailure(err);
                    })[fnName].apply(null, args);
                };
              }
            });
          }

          window.google.script.run = wrapGasChain(null, null);
        }

        window.__androidOnSyncCompleted = function(syncedCount) {
          try {
            if (typeof rekCache !== 'undefined') rekCache = {};
            if (typeof missingCache !== 'undefined') missingCache = null;
            if (typeof loadInit === 'function') loadInit(true);
            if (typeof loadGaleri === 'function') loadGaleri();
          } catch (e) {}
        };

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
