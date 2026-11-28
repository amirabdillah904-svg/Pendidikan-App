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
  private val onSetNfcLockMode: (locked: Boolean, mode: String) -> Unit = { _, _ -> },
  private val onGetNfcStatus: () -> String = { "{\"supported\":false,\"enabled\":false,\"locked\":false,\"mode\":\"idle\"}" },
  private val onOpenNfcSettings: () -> Unit = {},
  private val onRequestCameraPermission: () -> Unit = {},
  private val onVibrateFeedback: (durationMs: Long) -> Unit = {},
  private val onSpeakAnnouncement: (text: String) -> Unit = {},
  private val onGetPendingOfflineQueueJson: () -> String = { "[]" },
  private val onRetrySingleOfflineOp: (clientOpId: String) -> Unit = {},
  private val onDeleteOfflineOp: (clientOpId: String) -> Unit = {},
  private val onIsAutoUploadOfflineEnabled: () -> Boolean = { true },
  private val onSetAutoUploadOfflineEnabled: (enabled: Boolean) -> Unit = {},
  private val onIsBackgroundNotifEnabled: () -> Boolean = { true },
  private val onSetBackgroundNotifEnabled: (enabled: Boolean) -> Unit = {},
  private val onSyncLastSeenContentIds: (pengumumanId: String, galeriId: String, userRole: String) -> Unit = { _, _, _ -> },
  private val onTriggerBackgroundCheckNow: () -> Unit = {},
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

  @JavascriptInterface
  fun setNfcLockMode(locked: Boolean, mode: String) {
    onSetNfcLockMode(locked, mode)
  }

  @JavascriptInterface
  fun getNfcStatus(): String {
    return onGetNfcStatus()
  }

  @JavascriptInterface
  fun openNfcSettings() {
    onOpenNfcSettings()
  }

  @JavascriptInterface
  fun requestCameraPermission() {
    onRequestCameraPermission()
  }

  @JavascriptInterface
  fun vibrateFeedback(durationMs: Long) {
    onVibrateFeedback(durationMs)
  }

  @JavascriptInterface
  fun speakAnnouncement(text: String) {
    val clean = text.trim().take(240)
    if (clean.isNotEmpty()) {
      onSpeakAnnouncement(clean)
    }
  }

  @JavascriptInterface
  fun getPendingOfflineQueueJson(): String {
    return onGetPendingOfflineQueueJson()
  }

  @JavascriptInterface
  fun retrySingleOfflineOp(clientOpId: String) {
    onRetrySingleOfflineOp(clientOpId)
  }

  @JavascriptInterface
  fun deleteOfflineOp(clientOpId: String) {
    onDeleteOfflineOp(clientOpId)
  }

  @JavascriptInterface
  fun isAutoUploadOfflineEnabled(): Boolean {
    return onIsAutoUploadOfflineEnabled()
  }

  @JavascriptInterface
  fun setAutoUploadOfflineEnabled(enabled: Boolean) {
    onSetAutoUploadOfflineEnabled(enabled)
  }

  @JavascriptInterface
  fun isBackgroundNotifEnabled(): Boolean {
    return onIsBackgroundNotifEnabled()
  }

  @JavascriptInterface
  fun setBackgroundNotifEnabled(enabled: Boolean) {
    onSetBackgroundNotifEnabled(enabled)
  }

  @JavascriptInterface
  fun syncLastSeenContentIds(pengumumanId: String, galeriId: String, userRole: String) {
    onSyncLastSeenContentIds(pengumumanId, galeriId, userRole)
  }

  @JavascriptInterface
  fun triggerBackgroundCheckNow() {
    onTriggerBackgroundCheckNow()
  }

  @JavascriptInterface
  fun syncAttendanceDeadlines(deadlinesJson: String) {
    com.example.offline.BackgroundSyncPrefs.setAttendanceDeadlinesJson(context, deadlinesJson)
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

        var lastNotifiedDark = null;
        function notifyTheme() {
          try {
            var curDark = document.documentElement.classList.contains('dark');
            if (curDark === lastNotifiedDark) return;
            lastNotifiedDark = curDark;
            if (window.AndroidBridge && typeof window.AndroidBridge.onThemeChanged === 'function') {
              window.AndroidBridge.onThemeChanged(curDark);
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

        // === SWEETALERT2 SAFEGUARD: PASTIKAN POPUP HASIL SELALU TAMPIL TOMBOL OK (BUKAN LOADING BERPUTAR) ===
        function installSwalSafeguard() {
          if (typeof window.Swal === 'undefined' || window.Swal.__androidPatched) return;
          var origFire = window.Swal.fire.bind(window.Swal);
          window.Swal.fire = function() {
            var args = Array.prototype.slice.call(arguments);
            if (args.length >= 2 && typeof args[0] === 'string') {
              try { if (typeof window.Swal.hideLoading === 'function') window.Swal.hideLoading(); } catch (e) {}
              return origFire({
                title: args[0],
                text: args[1] || '',
                icon: args[2] || undefined,
                showConfirmButton: true,
                confirmButtonText: 'OK',
                confirmButtonColor: '#4F46E5',
                allowOutsideClick: true,
                didOpen: function() {
                  try { if (typeof window.Swal.hideLoading === 'function') window.Swal.hideLoading(); } catch (e) {}
                }
              });
            }
            if (args.length === 1 && args[0] && typeof args[0] === 'object') {
              var opts = Object.assign({}, args[0]);
              var isLoadingModal = typeof opts.didOpen === 'function' && String(opts.didOpen).indexOf('showLoading') !== -1;
              if (!isLoadingModal) {
                if (typeof opts.showConfirmButton === 'undefined' && !opts.timer) {
                  opts.showConfirmButton = true;
                }
                if (opts.showConfirmButton !== false && !opts.confirmButtonText) {
                  opts.confirmButtonText = 'OK';
                }
                if (!opts.confirmButtonColor) {
                  opts.confirmButtonColor = '#4F46E5';
                }
                var origDidOpen = opts.didOpen;
                opts.didOpen = function(el) {
                  try { if (typeof window.Swal.hideLoading === 'function') window.Swal.hideLoading(); } catch (e) {}
                  if (typeof origDidOpen === 'function') origDidOpen(el);
                };
              }
              return origFire(opts);
            }
            return origFire.apply(window.Swal, args);
          };
          window.Swal.__androidPatched = true;
        }
        installSwalSafeguard();
        setTimeout(installSwalSafeguard, 800);
        setTimeout(installSwalSafeguard, 2200);

        // === OFFLINE-FIRST & REAL-TIME INFORMATION NOTIFICATION INTERCEPTOR ===
        var READ_FNS = [
          'getFastLoginData', 'getInitialBundle', 'getRekapData', 'getMissingAttendance',
          'getFinancialData', 'getUsersData', 'getWaliSantriUsers', 'getPengumuman', 'getGaleriData',
          'getSaran', 'getSurat', 'getDbData', 'getIzinDigital', 'getSantriTindakan',
          'getDriveBackupStatus', 'getUserProfilePhoto'
        ];
        var WRITE_FNS = [
          'submitAbsensi', 'saveFinancialData', 'deleteFinancialData',
          'savePengumuman', 'deletePengumuman', 'saveGaleriData', 'deleteGaleriData',
          'toggleGaleriLike', 'saveSaran', 'deleteSaran', 'saveSuratData', 'deleteSurat',
          'saveDbData', 'deleteDbData', 'saveUserData', 'deleteUserData',
          'saveWaliSantriUser', 'deleteWaliSantriUser', 'updateAppSettings',
          'saveIzinDigital', 'updateIzinDigitalStatus', 'deleteIzinDigital', 'saveSantriTindakan',
          'saveDriveBackupConfig', 'backupSuratPdfToDrive', 'saveUserProfilePhoto'
        ];

        function isValidGasReadPayload(fnName, res) {
          if (res === null || typeof res === 'undefined') return false;
          if (typeof res === 'string') {
            var s = res.trim().toLowerCase();
            if (s.indexOf('<') === 0 || s.indexOf('<!doctype') !== -1) return false;
          }
          if (typeof res === 'object' && res.success === false && typeof res.error === 'string' && res.error.trim().length > 0) {
            return false;
          }
          if (fnName === 'getMissingAttendance') {
            return Boolean(res && typeof res === 'object' && (Array.isArray(res.wb) || Array.isArray(res.takhassus) || (res.riwayat && typeof res.riwayat === 'object')));
          }
          return true;
        }

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
          if (fnName === 'savePengumuman') return 'Informasi Baru';
          if (fnName === 'saveGaleriData') return 'Foto Galeri Santri';
          if (fnName === 'saveSaran') return 'Kotak Saran';
          if (fnName === 'saveSuratData' && first) return 'Arsip Surat • ' + String(first.perihal || '');
          if (fnName === 'saveDbData') return 'Database (' + String((args && args[0]) || '') + ')';
          if (fnName === 'saveUserData') return 'Data User';
          if (fnName === 'saveWaliSantriUser') return 'Akun Wali Santri';
          if (fnName === 'deleteWaliSantriUser') return 'Hapus Akun Wali Santri';
          if (fnName === 'updateAppSettings') return 'Setelan Aplikasi';
          if (fnName === 'saveIzinDigital' && first) return 'Izin Digital • ' + String(first.namaSantri || '');
          if (fnName === 'updateIzinDigitalStatus') return 'Persetujuan Izin Digital';
          if (fnName === 'deleteIzinDigital') return 'Hapus Izin Digital';
          if (fnName === 'saveSantriTindakan' && first) return 'Tindakan Santri • ' + String(first.namaSantri || '');
          return 'Data ' + fnName;
        }

        function checkRealtimeAnnouncement(listOrObj) {
          try {
            var list = Array.isArray(listOrObj)
              ? listOrObj
              : (listOrObj && Array.isArray(listOrObj.pengumuman) ? listOrObj.pengumuman : null);
            if (!list || !list.length) return;
            var latest = list[0];
            var latestId = String(latest.id || (String(latest.tanggal || '') + '_' + String(latest.isi || '').slice(0, 40)));
            var prevId = localStorage.getItem('alrifaie_last_seen_pengumuman_id');
            if (prevId && prevId !== latestId && window.AndroidBridge && typeof window.AndroidBridge.notifyRealtimeEvent === 'function') {
              var author = latest.penulis ? (' (' + latest.penulis + ')') : '';
              window.AndroidBridge.notifyRealtimeEvent(
                'Informasi Baru • Dept. Pendidikan',
                String(latest.isi || 'Ada pengumuman baru.') + author
              );
            }
            localStorage.setItem('alrifaie_last_seen_pengumuman_id', latestId);
            if (window.AndroidBridge && typeof window.AndroidBridge.syncLastSeenContentIds === 'function') {
              var roleStr = (window.session && window.session.role) ? String(window.session.role) : '';
              window.AndroidBridge.syncLastSeenContentIds(latestId, '', roleStr);
            }
          } catch (e) {}
        }

        function checkRealtimeGallery(listOrObj) {
          try {
            var list = Array.isArray(listOrObj)
              ? listOrObj
              : (listOrObj && Array.isArray(listOrObj.galeri) ? listOrObj.galeri : null);
            if (!list || !list.length) return;
            var latest = list[0];
            var latestId = String(latest.id || (String(latest.tanggal || '') + '_' + String(latest.caption || '').slice(0, 30)));
            var prevId = localStorage.getItem('alrifaie_last_seen_galeri_id');
            if (prevId && prevId !== latestId && window.AndroidBridge && typeof window.AndroidBridge.notifyRealtimeEvent === 'function') {
              var body = (latest.tag ? '[' + latest.tag + '] ' : '') +
                (latest.caption || 'Foto dokumentasi kegiatan santri terbaru telah diunggah.') +
                (latest.penulis ? ' — ' + latest.penulis : '');
              window.AndroidBridge.notifyRealtimeEvent('Galeri Santri Baru • Dept. Pendidikan', body);
            }
            localStorage.setItem('alrifaie_last_seen_galeri_id', latestId);
            if (window.AndroidBridge && typeof window.AndroidBridge.syncLastSeenContentIds === 'function') {
              var roleStr = (window.session && window.session.role) ? String(window.session.role) : '';
              window.AndroidBridge.syncLastSeenContentIds('', latestId, roleStr);
            }
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
                            if (typeof onSuccess === 'function') {
                              setTimeout(function() { onSuccess(parsed); }, 10);
                            }
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
                        if (!isValidGasReadPayload(fnName, res)) {
                          if (!tryServeCache() && typeof onFailure === 'function') {
                            onFailure(new Error((res && res.error) ? String(res.error) : 'Respons server tidak valid.'));
                          }
                          return;
                        }
                        try {
                          if (window.AndroidBridge && typeof window.AndroidBridge.cacheGasRead === 'function') {
                            window.AndroidBridge.cacheGasRead(cacheKey, fnName, JSON.stringify(res));
                          }
                          if (fnName === 'getFastLoginData' || fnName === 'getInitialBundle') {
                            checkRealtimeAnnouncement(res);
                            checkRealtimeGallery(res);
                          } else if (fnName === 'getPengumuman') {
                            checkRealtimeAnnouncement(res);
                          } else if (fnName === 'getGaleriData') {
                            checkRealtimeGallery(res);
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
                    var firstArg = (args && args.length > 0 && args[0] && typeof args[0] === 'object') ? args[0] : null;
                    var isSilentSingleScan = (fnName === 'submitAbsensi' && firstArg && firstArg.isSingleScanUpdate === true);
                    var queueLocally = function() {
                      try {
                        if (window.AndroidBridge && typeof window.AndroidBridge.enqueueOfflineWrite === 'function') {
                          window.AndroidBridge.enqueueOfflineWrite(opId, fnName, JSON.stringify(args), label);
                        }
                      } catch (e) {}
                      if (isSilentSingleScan) {
                        if (typeof onSuccess === 'function') {
                          setTimeout(function() {
                            onSuccess({
                              success: true,
                              offlineQueued: true,
                              clientOpId: opId,
                              message: 'Scan tersimpan lokal (Offline). Akan disinkronkan otomatis saat online.'
                            });
                          }, 20);
                        }
                        return;
                      }
                      // Jalankan asinkron agar Swal.showLoading() dari dialog sebelumnya tidak menimpa tombol OK!
                      setTimeout(function() {
                        try {
                          if (typeof window.Swal !== 'undefined') {
                            if (typeof window.Swal.hideLoading === 'function') window.Swal.hideLoading();
                            if (typeof window.Swal.close === 'function') window.Swal.close();
                          }
                        } catch (e) {}
                        if (typeof onSuccess === 'function') {
                          onSuccess({
                            success: true,
                            offlineQueued: true,
                            clientOpId: opId,
                            message: 'Data tersimpan secara lokal (Offline). Akan disinkronkan otomatis ke Google Sheet saat koneksi kembali stabil.'
                          });
                        }
                      }, 130);
                    };

                    if (!navigator.onLine) {
                      queueLocally();
                      return;
                    }

                    rawGasRun
                      .withSuccessHandler(function(res) {
                        try {
                          if (window.AndroidBridge) {
                            if (fnName === 'savePengumuman' && typeof window.AndroidBridge.notifyRealtimeEvent === 'function') {
                              var infoBody = String((args && args[0]) || 'Informasi baru berhasil dipublikasikan.');
                              var infoAuthor = (args && args[1]) ? (' — ' + String(args[1])) : '';
                              window.AndroidBridge.notifyRealtimeEvent('Informasi Baru Dipublikasikan', infoBody + infoAuthor);
                            } else if (fnName === 'saveGaleriData' && typeof window.AndroidBridge.notifyRealtimeEvent === 'function') {
                              var galObj = (args && args[0] && typeof args[0] === 'object') ? args[0] : {};
                              var galBody = (galObj.tag ? '[' + galObj.tag + '] ' : '') + (galObj.caption || 'Foto kegiatan santri baru telah diunggah.');
                              window.AndroidBridge.notifyRealtimeEvent('Galeri Santri Baru Diunggah', galBody);
                            } else if (typeof window.AndroidBridge.notifyOnlineWriteSuccess === 'function') {
                              if (!isSilentSingleScan && (fnName === 'submitAbsensi' || fnName === 'saveFinancialData' || fnName === 'saveSuratData')) {
                                window.AndroidBridge.notifyOnlineWriteSuccess(label);
                              }
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

          // Polling hemat kuota setiap 90 detik saat online & aktif (tidak membebani kuota Apps Script)
          var lastPollAt = 0;
          function pollLatestUpdates() {
            if (!navigator.onLine) return;
            var nowMs = Date.now();
            if (nowMs - lastPollAt < 40000) return;
            lastPollAt = nowMs;
            try {
              rawGasRun
                .withSuccessHandler(function(res) {
                  if (!isValidGasReadPayload('getFastLoginData', res)) return;
                  checkRealtimeAnnouncement(res);
                  checkRealtimeGallery(res);
                  if (res && Array.isArray(res.pengumuman) && typeof renderPengumuman === 'function') {
                    pengumumanCache = res.pengumuman;
                    renderPengumuman(pengumumanCache);
                  }
                })
                .withFailureHandler(function() {})
                .getFastLoginData();
            } catch (e) {}
          }

          if (!window.__androidInfoPollerStarted) {
            window.__androidInfoPollerStarted = true;
            setInterval(function() {
              if (document.visibilityState === 'visible') pollLatestUpdates();
            }, 90000);
            document.addEventListener('visibilitychange', function() {
              if (document.visibilityState === 'visible') pollLatestUpdates();
            });
          }
        }

        window.__androidOnSyncCompleted = function(syncedCount) {
          try {
            if (typeof rekCache !== 'undefined') rekCache = {};
            if (typeof missingCache !== 'undefined') missingCache = null;
            if (typeof window.invalidateMissingAttendanceCache === 'function') {
              window.invalidateMissingAttendanceCache();
            }
            if (typeof loadInit === 'function') loadInit(true);
            if (typeof loadGaleri === 'function') loadGaleri();
            if (window.AlRifaieSmart && typeof window.AlRifaieSmart.refreshMissingMonitor === 'function') {
              window.AlRifaieSmart.refreshMissingMonitor(false);
            }
            var tungTab = document.getElementById('tab-tunggakan');
            if (tungTab && !tungTab.classList.contains('hidden') && typeof loadMissingAttendance === 'function') {
              loadMissingAttendance(true);
            }
          } catch (e) {}
        };

        window.__androidHandleBack = function() {
          try {
            var logoutModal = document.getElementById('logoutConfirmModal');
            if (logoutModal && !logoutModal.classList.contains('hidden') && typeof closeLogoutConfirmModal === 'function') {
              closeLogoutConfirmModal();
              return 'handled';
            }
            if (typeof Swal !== 'undefined' && typeof Swal.isVisible === 'function' && Swal.isVisible()) {
              Swal.close();
              return 'handled';
            }
            if (window.AlRifaieSmart && typeof window.AlRifaieSmart.isBottomSheetOpen === 'function' && window.AlRifaieSmart.isBottomSheetOpen()) {
              window.AlRifaieSmart.closeBottomSheet();
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
            var loginSec = document.getElementById('loginSection');
            var chooserWrap = document.getElementById('loginChooserWrap');
            if (loginSec && !loginSec.classList.contains('hidden') && chooserWrap && chooserWrap.classList.contains('hidden') && typeof window.showLoginChooser === 'function') {
              window.showLoginChooser();
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
