/**
 * =========================================================================
 * BACKEND OFFLINE-FIRST & GOOGLE SHEET SYNC (GOOGLE APPS SCRIPT)
 * Departemen Pendidikan - YPM Al-Rifa'ie 2
 * =========================================================================
 * Tambahkan kode ini ke file baru di Google Apps Script (misalnya: OfflineSync.gs)
 * lalu pastikan doGet(e) dan doPost(e) Anda memanggil handler ini (atau ganti
 * doGet/doPost lama jika sebelumnya hanya melayani JSONP/POST dasar).
 *
 * Fitur:
 * 1. Idempotency (Anti-Duplikat) dengan Sheet "SyncLog" + LockService
 * 2. Endpoint `syncOfflineBatch` untuk menerima antrean data offline sekaligus
 * 3. Kompatibel penuh dengan seluruh fungsi existing (submitAbsensi, saveFinancialData, dll.)
 */

const SYNC_LOG_SHEET_NAME = 'SyncLog';

/**
 * Handler GET (JSONP / Health Check / Read-Only)
 * Jika Code.gs Anda sudah punya doGet(e) untuk HtmlService, gabungkan bagian
 * `if (e && e.parameter && e.parameter.payload)` di bagian paling atas doGet(e) Anda.
 */
function doGet(e) {
  try {
    if (e && e.parameter && e.parameter.payload) {
      const req = JSON.parse(e.parameter.payload);
      const fnName = req.fn || req.action || '';
      const args = Array.isArray(req.args) ? req.args : [];
      const result = routeOfflineFirstAction_(fnName, args, req.clientOpId || '');
      const cb = e.parameter.callback;
      if (cb) {
        return ContentService
          .createTextOutput(cb + '(' + JSON.stringify(result) + ');')
          .setMimeType(ContentService.MimeType.JAVASCRIPT);
      }
      return createJsonOutput_(result);
    }

    if (e && e.parameter && e.parameter.action === 'ping') {
      return createJsonOutput_({
        ok: true,
        status: 'online',
        serverTime: new Date().toISOString()
      });
    }

    // Fallback: tampilkan web app HTML seperti biasa jika dibuka dari browser
    return HtmlService.createHtmlOutputFromFile('Index')
      .setTitle("Departemen Pendidikan - YPM Al-Rifa'ie 2")
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  } catch (err) {
    const errPayload = { success: false, error: err && err.message ? err.message : String(err) };
    if (e && e.parameter && e.parameter.callback) {
      return ContentService
        .createTextOutput(e.parameter.callback + '(' + JSON.stringify(errPayload) + ');')
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return createJsonOutput_(errPayload);
  }
}

/**
 * Handler POST (Single Write + Batch Offline-First Sync)
 */
function doPost(e) {
  try {
    const rawBody = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
    const body = JSON.parse(rawBody);
    const fnName = body.fn || body.action || '';
    const args = Array.isArray(body.args)
      ? body.args
      : (typeof body.payload !== 'undefined' ? [body.payload] : []);
    const clientOpId = body.clientOpId || '';

    if (fnName === 'syncOfflineBatch') {
      const batchItems = Array.isArray(args[0]) ? args[0] : (Array.isArray(body.payload) ? body.payload : []);
      return createJsonOutput_(syncOfflineBatch(batchItems));
    }

    const result = routeOfflineFirstAction_(fnName, args, clientOpId);
    return createJsonOutput_(result);
  } catch (err) {
    return createJsonOutput_({
      success: false,
      error: err && err.message ? err.message : String(err)
    });
  }
}

/**
 * Memproses antrean data offline secara berurutan (FIFO) dengan LockService
 * dan pencegahan duplikasi berbasis clientOpId.
 * @param {Array<Object>} items - Daftar operasi: [{ clientOpId, fn, args, createdAt }]
 */
function tryAcquireLock_(lock, waitMs) {
  try {
    if (lock.tryLock(waitMs || 12000)) return true;
  } catch (e) {}
  try {
    Utilities.sleep(400);
    return lock.tryLock(5000);
  } catch (e2) {
    return false;
  }
}

function syncOfflineBatch(items) {
  const lock = LockService.getScriptLock();
  if (!tryAcquireLock_(lock, 15000)) {
    return {
      success: false,
      busy: true,
      batchHandled: false,
      message: 'Server sedang sibuk memproses antrean lain. Aplikasi akan mencoba ulang otomatis.'
    };
  }
  try {
    const list = Array.isArray(items) ? items : [];
    const results = [];
    let syncedCount = 0;
    let duplicateCount = 0;
    let failedCount = 0;

    for (let i = 0; i < list.length; i++) {
      const item = list[i] || {};
      const clientOpId = String(item.clientOpId || '').trim();
      const fnName = String(item.fn || '').trim();
      const args = Array.isArray(item.args) ? item.args : [];

      if (!clientOpId || !fnName) {
        failedCount++;
        results.push({
          clientOpId: clientOpId,
          ok: false,
          error: 'Format operasi tidak valid (clientOpId atau fn kosong).'
        });
        continue;
      }

      // Cek apakah clientOpId sudah pernah diproses sebelumnya (Anti-Duplikat)
      if (isOpAlreadySynced_(clientOpId)) {
        duplicateCount++;
        results.push({
          clientOpId: clientOpId,
          ok: true,
          duplicate: true
        });
        continue;
      }

      try {
        const res = dispatchExistingFunction_(fnName, args);
        const rejected = res && typeof res === 'object' && res.success === false;
        if (rejected) {
          failedCount++;
          results.push({
            clientOpId: clientOpId,
            ok: false,
            error: res.message || res.error || 'Ditolak oleh server'
          });
        } else {
          recordSyncedOp_(clientOpId, fnName, 'OK');
          syncedCount++;
          results.push({
            clientOpId: clientOpId,
            ok: true,
            duplicate: false,
            data: res
          });
        }
      } catch (err) {
        failedCount++;
        results.push({
          clientOpId: clientOpId,
          ok: false,
          error: err && err.message ? err.message : String(err)
        });
      }
    }

    return {
      success: failedCount === 0,
      batchHandled: true,
      syncedCount: syncedCount,
      duplicateCount: duplicateCount,
      failedCount: failedCount,
      serverTime: new Date().toISOString(),
      results: results
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Router untuk single request (dengan proteksi anti-duplikat bila clientOpId disertakan)
 */
function routeOfflineFirstAction_(fnName, args, clientOpId) {
  if (fnName === 'ping') {
    return { ok: true, serverTime: new Date().toISOString() };
  }

  const isWriteWithId = Boolean(clientOpId);
  if (!isWriteWithId) {
    return dispatchExistingFunction_(fnName, args);
  }

  const lock = LockService.getScriptLock();
  if (!tryAcquireLock_(lock, 15000)) {
    return {
      success: false,
      busy: true,
      message: 'Server sedang sibuk, silakan coba beberapa detik lagi.'
    };
  }
  try {
    if (isOpAlreadySynced_(clientOpId)) {
      return { success: true, duplicate: true, message: 'Data sudah tersinkron sebelumnya.' };
    }
    const result = dispatchExistingFunction_(fnName, args);
    const rejected = result && typeof result === 'object' && result.success === false;
    if (!rejected) {
      recordSyncedOp_(clientOpId, fnName, 'OK');
    }
    return result;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Memanggil fungsi-fungsi existing yang sudah ada di proyek Apps Script Anda.
 */
function dispatchExistingFunction_(fnName, args) {
  if (fnName === 'uploadHdImage') {
    return uploadHdImage(args && args[0] ? args[0] : {});
  }
  if (fnName === 'getWaliSantriUsers') {
    return getWaliSantriUsers();
  }
  if (fnName === 'saveWaliSantriUser') {
    return saveWaliSantriUser(args && args[0] ? args[0] : {});
  }
  if (fnName === 'deleteWaliSantriUser') {
    return deleteWaliSantriUser(args && args[0] ? args[0] : '');
  }
  if (fnName === 'verifyWaliSantriLogin') {
    return verifyWaliSantriLogin(args && args[0] ? args[0] : '', args && args[1] ? args[1] : '');
  }
  if (fnName === 'verifyLogin' && args && String(args[0] || '').toLowerCase() === 'walisantri') {
    return verifyWaliSantriLogin(args[1] || '', args[2] || '');
  }
  if (fnName === 'getIzinDigital') {
    return getIzinDigital();
  }
  if (fnName === 'saveIzinDigital') {
    return saveIzinDigital(args && args[0] ? args[0] : {});
  }
  if (fnName === 'updateIzinDigitalStatus') {
    return updateIzinDigitalStatus(args && args[0] ? args[0] : '', args && args[1] ? args[1] : '', args && args[2] ? args[2] : '', args && args[3] ? args[3] : '');
  }
  if (fnName === 'deleteIzinDigital') {
    return deleteIzinDigital(args && args[0] ? args[0] : '');
  }
  if (fnName === 'getSantriTindakan') {
    return getSantriTindakan();
  }
  if (fnName === 'saveSantriTindakan') {
    return saveSantriTindakan(args && args[0] ? args[0] : {});
  }
  if (fnName === 'getDriveBackupStatus') {
    return getDriveBackupStatus();
  }
  if (fnName === 'saveDriveBackupConfig') {
    return saveDriveBackupConfig(args && args[0] ? args[0] : {});
  }
  if (fnName === 'backupSuratPdfToDrive') {
    return backupSuratPdfToDrive(args && args[0] ? args[0] : {});
  }
  if (fnName === 'getUserProfilePhoto') {
    return getUserProfilePhoto(args && args[0] ? args[0] : '');
  }
  if (fnName === 'saveUserProfilePhoto') {
    return saveUserProfilePhoto(args && args[0] ? args[0] : {});
  }

  // Otomatis cadangkan foto Galeri & file Surat ke Google Drive agar tidak membebani limit 50.000 karakter sel Google Sheet
  const safeArgs = Array.isArray(args) ? args.slice() : [];
  let driveBackupMeta = null;

  if (fnName === 'saveGaleriData' && safeArgs[0] && typeof safeArgs[0] === 'object') {
    const item = Object.assign({}, safeArgs[0]);
    const driveCfg = getDriveBackupConfig_();
    if (driveCfg.enabled && driveCfg.backupGaleri && typeof item.imageUrl === 'string' && item.imageUrl.indexOf('data:image/') === 0) {
      try {
        const up = saveHdImageToDrive_(item.imageUrl, 'galeri_santri', 'Galeri_Santri');
        if (up && up.url) {
          item.imageUrl = up.url;
          item.driveFileId = up.fileId;
          item.driveUrl = up.viewUrl;
          driveBackupMeta = up;
        }
      } catch (drvErr) {
        Logger.log('Info backup Drive galeri: ' + drvErr);
      }
    }
    safeArgs[0] = item;
  } else if (fnName === 'saveSuratData' && safeArgs[0] && typeof safeArgs[0] === 'object') {
    const suratPayload = Object.assign({}, safeArgs[0]);
    const htmlSnap = suratPayload.driveHtmlSnapshot || '';
    delete suratPayload.driveHtmlSnapshot;
    const driveCfg = getDriveBackupConfig_();
    if (driveCfg.enabled && driveCfg.backupSurat) {
      try {
        driveBackupMeta = backupSuratHtmlToDriveInternal_(suratPayload, htmlSnap);
        if (driveBackupMeta && driveBackupMeta.viewUrl) {
          suratPayload.driveFileId = driveBackupMeta.fileId;
          suratPayload.driveUrl = driveBackupMeta.viewUrl;
        }
      } catch (suratDrvErr) {
        Logger.log('Info backup Drive surat: ' + suratDrvErr);
      }
    }
    safeArgs[0] = suratPayload;
  } else if (fnName === 'updateAppSettings' && safeArgs[0] && typeof safeArgs[0] === 'object') {
    const cfg = Object.assign({}, safeArgs[0]);
    if (typeof cfg.bannerUrl === 'string' && cfg.bannerUrl.indexOf('data:image/') === 0) {
      try {
        const upBanner = saveHdImageToDrive_(cfg.bannerUrl, 'banner', 'Media_Aplikasi');
        if (upBanner && upBanner.url) cfg.bannerUrl = upBanner.url;
      } catch (e) {}
    }
    if (typeof cfg.logoUrl === 'string' && cfg.logoUrl.indexOf('data:image/') === 0) {
      try {
        const upLogo = saveHdImageToDrive_(cfg.logoUrl, 'logo', 'Media_Aplikasi');
        if (upLogo && upLogo.url) cfg.logoUrl = upLogo.url;
      } catch (e) {}
    }
    try {
      const props = PropertiesService.getScriptProperties();
      if (cfg.attendanceDeadlines && typeof cfg.attendanceDeadlines === 'object') {
        props.setProperty('ALRIFAIE_ATTENDANCE_DEADLINES', JSON.stringify(cfg.attendanceDeadlines));
      }
      if (cfg.rolePermissions && typeof cfg.rolePermissions === 'object') {
        props.setProperty('ALRIFAIE_ROLE_PERMISSIONS', JSON.stringify(cfg.rolePermissions));
      }
      if (cfg.staffPermissionOverrides && typeof cfg.staffPermissionOverrides === 'object') {
        props.setProperty('ALRIFAIE_STAFF_PERM_OVERRIDES', JSON.stringify(cfg.staffPermissionOverrides));
      }
      if (cfg.driveConfig && typeof cfg.driveConfig === 'object') {
        saveDriveBackupConfig(cfg.driveConfig);
      }
    } catch (propErr) {
      Logger.log('Info simpan extra settings: ' + propErr);
    }
    safeArgs[0] = cfg;
  }

  const allowed = {
    getFastLoginData: typeof getFastLoginData === 'function' ? getFastLoginData : null,
    getInitialBundle: typeof getInitialBundle === 'function' ? getInitialBundle : null,
    verifyLogin: typeof verifyLogin === 'function' ? verifyLogin : null,
    submitAbsensi: typeof submitAbsensi === 'function' ? submitAbsensi : null,
    getRekapData: typeof getRekapData === 'function' ? getRekapData : null,
    getMissingAttendance: typeof getMissingAttendance === 'function' ? getMissingAttendance : null,
    getFinancialData: typeof getFinancialData === 'function' ? getFinancialData : null,
    saveFinancialData: typeof saveFinancialData === 'function' ? saveFinancialData : null,
    deleteFinancialData: typeof deleteFinancialData === 'function' ? deleteFinancialData : null,
    getUsersData: typeof getUsersData === 'function' ? getUsersData : null,
    saveUserData: typeof saveUserData === 'function' ? saveUserData : null,
    deleteUserData: typeof deleteUserData === 'function' ? deleteUserData : null,
    updateAdminCredentials: typeof updateAdminCredentials === 'function' ? updateAdminCredentials : null,
    updateAppSettings: typeof updateAppSettings === 'function' ? updateAppSettings : null,
    getPengumuman: typeof getPengumuman === 'function' ? getPengumuman : null,
    savePengumuman: typeof savePengumuman === 'function' ? savePengumuman : null,
    deletePengumuman: typeof deletePengumuman === 'function' ? deletePengumuman : null,
    getGaleriData: typeof getGaleriData === 'function' ? getGaleriData : null,
    saveGaleriData: typeof saveGaleriData === 'function' ? saveGaleriData : null,
    deleteGaleriData: typeof deleteGaleriData === 'function' ? deleteGaleriData : null,
    toggleGaleriLike: typeof toggleGaleriLike === 'function' ? toggleGaleriLike : null,
    saveSaran: typeof saveSaran === 'function' ? saveSaran : null,
    getSaran: typeof getSaran === 'function' ? getSaran : null,
    deleteSaran: typeof deleteSaran === 'function' ? deleteSaran : null,
    getSurat: typeof getSurat === 'function' ? getSurat : null,
    saveSuratData: typeof saveSuratData === 'function' ? saveSuratData : null,
    deleteSurat: typeof deleteSurat === 'function' ? deleteSurat : null,
    getDbData: typeof getDbData === 'function' ? getDbData : null,
    saveDbData: typeof saveDbData === 'function' ? saveDbData : null,
    deleteDbData: typeof deleteDbData === 'function' ? deleteDbData : null
  };

  const targetFn = allowed[fnName];
  if (!targetFn) {
    throw new Error('Fungsi tidak dikenali atau belum tersedia di Apps Script: ' + fnName);
  }

  // Server-side cache untuk endpoint baca berat agar Apps Script tidak timeout / kelebihan beban
  if (fnName === 'getMissingAttendance') {
    const cacheTgl = String(safeArgs[0] || '').trim();
    const cacheBulan = String(safeArgs[1] || '').trim();
    const cacheKey = 'MISSING_ATT_V1_' + cacheTgl + '_' + cacheBulan;
    const snapPropKey = 'ALRIFAIE_LAST_MISSING_SNAP_V1';
    try {
      const scriptCache = CacheService.getScriptCache();
      const cachedJson = scriptCache.get(cacheKey);
      if (cachedJson) {
        return JSON.parse(cachedJson);
      }
      let freshResult = null;
      try {
        freshResult = targetFn.apply(null, safeArgs);
      } catch (missErr) {
        Logger.log('Fallback getMissingAttendance karena error: ' + missErr);
        freshResult = computeMissingAttendanceFallbackServer_(cacheTgl, cacheBulan);
      }
      if (!freshResult || typeof freshResult !== 'object') {
        freshResult = computeMissingAttendanceFallbackServer_(cacheTgl, cacheBulan);
      }
      if (freshResult && typeof freshResult === 'object') {
        const serialized = JSON.stringify(freshResult);
        if (serialized && serialized.length < 95000) {
          scriptCache.put(cacheKey, serialized, 180);
          trackCacheKey_(scriptCache, 'MISSING_ATT_V1_KEYS', cacheKey);
          try {
            if (serialized.length < 8000) {
              PropertiesService.getScriptProperties().setProperty(snapPropKey, serialized);
            }
          } catch (propSnapErr) {}
        }
        return freshResult;
      }
    } catch (cacheErr) {
      Logger.log('Info cache getMissingAttendance: ' + cacheErr);
    }
    try {
      const lastSnap = PropertiesService.getScriptProperties().getProperty(snapPropKey);
      if (lastSnap) return JSON.parse(lastSnap);
    } catch (snapReadErr) {}
    return { wb: [], takhassus: [], riwayat: {} };
  }

  if (fnName === 'getRekapData' || fnName === 'getFastLoginData' || fnName === 'getGaleriData') {
    const readArgKey = safeArgs.length ? String(safeArgs[0] || '').trim() : 'all';
    const readCacheKey = 'READ_CACHE_V1_' + fnName + '_' + readArgKey;
    const ttlSec = fnName === 'getRekapData' ? 60 : 90;
    try {
      const scriptCache = CacheService.getScriptCache();
      const hit = scriptCache.get(readCacheKey);
      if (hit) {
        return JSON.parse(hit);
      }
      const freshRead = targetFn.apply(null, safeArgs);
      if (freshRead !== null && typeof freshRead !== 'undefined') {
        const enriched = enrichReadResult_(fnName, freshRead);
        const ser = JSON.stringify(enriched);
        if (ser && ser.length < 95000) {
          scriptCache.put(readCacheKey, ser, ttlSec);
          trackCacheKey_(scriptCache, 'READ_CACHE_V1_KEYS', readCacheKey);
        }
        return enriched;
      }
    } catch (readCacheErr) {
      Logger.log('Info read cache ' + fnName + ': ' + readCacheErr);
    }
  }

  const result = targetFn.apply(null, safeArgs);

  // Bersihkan cache server otomatis saat ada data baru/perubahan agar semua klien selalu sinkron
  invalidateReadCachesForWrite_(fnName);

  // Sisipkan batas waktu absen, hak akses peran & konfigurasi Drive ke respons settings secara otomatis
  try {
    if ((fnName === 'getInitialBundle' || fnName === 'getFastLoginData') && result && typeof result === 'object') {
      return enrichReadResult_(fnName, result);
    }
    if (fnName === 'getSurat' && Array.isArray(result)) {
      const suratMap = readSuratDriveMap_();
      return result.map(function (row) {
        const key = normalizeSuratDriveKey_(row && row.nomor, row && row.perihal);
        const meta = suratMap[key] || (row && row.id ? suratMap['id_' + String(row.id)] : null);
        if (meta && meta.viewUrl) {
          return Object.assign({}, row, {
            driveFileId: meta.fileId || '',
            driveUrl: meta.viewUrl || '',
            driveFileName: meta.fileName || ''
          });
        }
        return row;
      });
    }
    if (fnName === 'saveSuratData' && driveBackupMeta && driveBackupMeta.viewUrl) {
      if (result && typeof result === 'object') {
        return Object.assign({}, result, {
          driveBackedUp: true,
          driveFileId: driveBackupMeta.fileId,
          driveUrl: driveBackupMeta.viewUrl
        });
      }
      return {
        success: true,
        driveBackedUp: true,
        driveFileId: driveBackupMeta.fileId,
        driveUrl: driveBackupMeta.viewUrl
      };
    }
    if (fnName === 'saveGaleriData' && driveBackupMeta && driveBackupMeta.viewUrl) {
      if (result && typeof result === 'object') {
        return Object.assign({}, result, {
          driveBackedUp: true,
          driveFileId: driveBackupMeta.fileId,
          driveUrl: driveBackupMeta.viewUrl,
          imageUrl: driveBackupMeta.url
        });
      }
      return {
        success: true,
        driveBackedUp: true,
        driveFileId: driveBackupMeta.fileId,
        driveUrl: driveBackupMeta.viewUrl,
        imageUrl: driveBackupMeta.url
      };
    }
  } catch (mergeErr) {
    Logger.log('Info merge extra settings/drive: ' + mergeErr);
  }

  // Otomatis tambahkan header "NFC Code" & "QR Code" pada sheet absensi / database setelah data masuk
  try {
    if (fnName === 'submitAbsensi' && safeArgs[0] && typeof safeArgs[0] === 'object') {
      syncAttendanceNfcQrColumns_(safeArgs[0]);
    } else if (fnName === 'saveDbData' && safeArgs[2] && typeof safeArgs[2] === 'object') {
      syncDatabaseNfcQrColumns_(safeArgs[0], safeArgs[1], safeArgs[2]);
    }
  } catch (extraErr) {
    Logger.log('Info sync kolom NFC/QR: ' + extraErr);
  }
  return result;
}

function trackCacheKey_(scriptCache, listKey, cacheKey) {
  try {
    const rawKeys = scriptCache.get(listKey);
    let keyList = [];
    try { keyList = rawKeys ? JSON.parse(rawKeys) : []; } catch (e) { keyList = []; }
    if (!Array.isArray(keyList)) keyList = [];
    if (keyList.indexOf(cacheKey) === -1) {
      keyList.push(cacheKey);
      if (keyList.length > 35) keyList = keyList.slice(keyList.length - 35);
      scriptCache.put(listKey, JSON.stringify(keyList), 600);
    }
  } catch (e) {}
}

function clearTrackedCacheKeys_(scriptCache, listKey) {
  try {
    const rawKeys = scriptCache.get(listKey);
    if (rawKeys) {
      const keyList = JSON.parse(rawKeys);
      if (Array.isArray(keyList) && keyList.length > 0) {
        scriptCache.removeAll(keyList);
      }
      scriptCache.remove(listKey);
    }
  } catch (e) {}
}

function invalidateReadCachesForWrite_(fnName) {
  try {
    const scriptCache = CacheService.getScriptCache();
    if (fnName === 'submitAbsensi') {
      clearTrackedCacheKeys_(scriptCache, 'MISSING_ATT_V1_KEYS');
      scriptCache.remove('READ_CACHE_V1_getRekapData_wb');
      scriptCache.remove('READ_CACHE_V1_getRekapData_takhassus');
      scriptCache.remove('READ_CACHE_V1_getRekapData_musyrif');
      scriptCache.remove('READ_CACHE_V1_getRekapData_pengajar');
    } else if (
      fnName === 'saveGaleriData' || fnName === 'deleteGaleriData' || fnName === 'toggleGaleriLike' ||
      fnName === 'savePengumuman' || fnName === 'deletePengumuman' ||
      fnName === 'updateAppSettings' || fnName === 'saveDbData' || fnName === 'deleteDbData' ||
      fnName === 'saveUserData' || fnName === 'deleteUserData'
    ) {
      clearTrackedCacheKeys_(scriptCache, 'READ_CACHE_V1_KEYS');
      if (fnName === 'saveDbData' || fnName === 'deleteDbData') {
        clearTrackedCacheKeys_(scriptCache, 'MISSING_ATT_V1_KEYS');
      }
    }
  } catch (invErr) {
    Logger.log('Info invalidate read cache: ' + invErr);
  }
}

function enrichReadResult_(fnName, result) {
  if ((fnName === 'getInitialBundle' || fnName === 'getFastLoginData') && result && typeof result === 'object') {
    try {
      const props = PropertiesService.getScriptProperties();
      const rawDl = props.getProperty('ALRIFAIE_ATTENDANCE_DEADLINES');
      const rawRp = props.getProperty('ALRIFAIE_ROLE_PERMISSIONS');
      const rawSp = props.getProperty('ALRIFAIE_STAFF_PERM_OVERRIDES');
      result.settings = result.settings && typeof result.settings === 'object' ? result.settings : {};
      if (rawDl) result.settings.attendanceDeadlines = JSON.parse(rawDl);
      if (rawRp) result.settings.rolePermissions = JSON.parse(rawRp);
      if (rawSp) result.settings.staffPermissionOverrides = JSON.parse(rawSp);
      try {
        result.settings.driveConfig = getDriveBackupConfig_();
      } catch (dcErr) {}
    } catch (e) {}
  }
  return result;
}

function computeMissingAttendanceFallbackServer_(tgl, monthStr) {
  try {
    const today = String(tgl || Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd')).slice(0, 10);
    const ym = String(monthStr || today.slice(0, 7));
    const norm = function (s) {
      return String(s || '').trim().toLowerCase().replace(/^(kamar|kelas)\s+/i, '').replace(/\s+/g, ' ').trim();
    };
    const bundle = typeof getInitialBundle === 'function' ? getInitialBundle() : null;
    const core = bundle && bundle.coreData ? bundle.coreData : {};
    const wbRooms = Array.isArray(core.rooms) ? core.rooms.filter(Boolean) : [];
    const tkClasses = Array.isArray(core.classes) ? core.classes.filter(Boolean) : [];
    const wbRecs = typeof getRekapData === 'function' ? (getRekapData('wb') || []) : [];
    const tkRecs = typeof getRekapData === 'function' ? (getRekapData('takhassus') || []) : [];

    const wbDoneToday = {};
    wbRecs.forEach(function (r) {
      if (String(r && r.tanggal || '').slice(0, 10) === today) wbDoneToday[norm(r.target)] = true;
    });
    const tkDoneToday = {};
    tkRecs.forEach(function (r) {
      if (String(r && r.tanggal || '').slice(0, 10) === today) tkDoneToday[norm(r.target)] = true;
    });

    const missingWb = wbRooms.filter(function (rm) { return !wbDoneToday[norm(rm)]; });
    const missingTk = tkClasses.filter(function (cl) { return !tkDoneToday[norm(cl)]; });

    const riwayat = {};
    const wbDates = {};
    wbRecs.forEach(function (r) {
      const d = String(r && r.tanggal || '').slice(0, 10);
      if (d.indexOf(ym) === 0) {
        if (!wbDates[d]) wbDates[d] = {};
        wbDates[d][norm(r.target)] = true;
      }
    });
    Object.keys(wbDates).sort().forEach(function (d) {
      wbRooms.forEach(function (rm) {
        if (!wbDates[d][norm(rm)]) {
          const lbl = '[WB] ' + rm;
          if (!riwayat[lbl]) riwayat[lbl] = [];
          riwayat[lbl].push(d);
        }
      });
    });

    const tkDates = {};
    tkRecs.forEach(function (r) {
      const d = String(r && r.tanggal || '').slice(0, 10);
      if (d.indexOf(ym) === 0) {
        if (!tkDates[d]) tkDates[d] = {};
        tkDates[d][norm(r.target)] = true;
      }
    });
    Object.keys(tkDates).sort().forEach(function (d) {
      tkClasses.forEach(function (cl) {
        if (!tkDates[d][norm(cl)]) {
          const lbl = '[Takhassus] ' + cl;
          if (!riwayat[lbl]) riwayat[lbl] = [];
          riwayat[lbl].push(d);
        }
      });
    });

    return { wb: missingWb, takhassus: missingTk, riwayat: riwayat };
  } catch (fbErr) {
    Logger.log('Fallback missing server gagal: ' + fbErr);
    return null;
  }
}

/**
 * Memastikan baris header (baris 1) pada sheet memiliki kolom tambahan (NFC Code, QR Code, Metode).
 * Mengembalikan map 1-based column index untuk setiap nama header yang diminta.
 */
function ensureExtraHeaders_(sheet, headerNames) {
  const lastCol = Math.max(1, sheet.getLastColumn());
  const existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) {
    return String(h || '').trim();
  });
  const colMap = {};
  let nextCol = lastCol;

  headerNames.forEach(function (name) {
    const idx = existing.findIndex(function (h) {
      return h.toLowerCase() === name.toLowerCase();
    });
    if (idx !== -1) {
      colMap[name] = idx + 1;
    } else {
      nextCol++;
      sheet.getRange(1, nextCol).setValue(name);
      colMap[name] = nextCol;
    }
  });
  return colMap;
}

/**
 * Menulis otomatis kolom "NFC Code", "QR Code", dan "Metode" pada sheet penyimpanan absensi
 * tanpa merusak struktur kolom absensi existing.
 */
function syncAttendanceNfcQrColumns_(payload) {
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!items.length) return;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const type = String(payload.type || '').toLowerCase();
  const candidateNames = {
    wb: ['Log_Absensi_WB', 'Absensi WB', 'Absensi Wajib Belajar', 'Rekap WB', 'Log Absensi WB'],
    takhassus: ['Log_Absensi_Takhassus', 'Absensi Takhassus', 'Rekap Takhassus', 'Log Absensi Takhassus'],
    musyrif: ['Log_Absensi_Musyrif', 'Absensi Musyrif', 'Rekap Musyrif', 'Log Absensi Musyrif'],
    pengajar: ['Log_Absensi_Pengajar', 'Absensi Pengajar', 'Rekap Pengajar', 'Log Absensi Pengajar']
  }[type] || [];

  let sheet = null;
  for (let i = 0; i < candidateNames.length; i++) {
    sheet = ss.getSheetByName(candidateNames[i]);
    if (sheet) break;
  }
  if (!sheet) {
    // Cari sheet yang namanya mengandung "absen" dan kata tipe
    const allSheets = ss.getSheets();
    sheet = allSheets.find(function (sh) {
      const n = sh.getName().toLowerCase();
      return n.indexOf('absen') !== -1 && n.indexOf(type) !== -1;
    }) || null;
  }
  if (!sheet || sheet.getLastRow() <= 1) return;

  const colMap = ensureExtraHeaders_(sheet, ['NFC Code', 'QR Code', 'Metode']);
  const lastRow = sheet.getLastRow();
  const scanWindow = Math.min(lastRow - 1, Math.max(items.length * 3, 60));
  const startRow = Math.max(2, lastRow - scanWindow + 1);
  const rowsData = sheet.getRange(startRow, 1, lastRow - startRow + 1, Math.min(8, sheet.getLastColumn())).getValues();

  items.forEach(function (it) {
    const namaLower = String(it.nama || '').trim().toLowerCase();
    if (!namaLower) return;
    for (let r = rowsData.length - 1; r >= 0; r--) {
      const rowMatched = rowsData[r].some(function (cell) {
        return String(cell || '').trim().toLowerCase() === namaLower;
      });
      if (rowMatched) {
        const sheetRow = startRow + r;
        if (it.nfcCode) sheet.getRange(sheetRow, colMap['NFC Code']).setValue(String(it.nfcCode));
        if (it.qrCode) sheet.getRange(sheetRow, colMap['QR Code']).setValue(String(it.qrCode));
        if (it.metodeAbsen) sheet.getRange(sheetRow, colMap['Metode']).setValue(String(it.metodeAbsen));
        break;
      }
    }
  });
}

/**
 * Menulis otomatis kolom "NFC Code" dan "QR Code" pada sheet database master (Santri/Musyrif/Pengajar).
 */
function syncDatabaseNfcQrColumns_(dbType, rowIdx, data) {
  const nfcCode = String(data.nfcCode || '').trim();
  const qrCode = String(data.qrCode || '').trim();
  if (!nfcCode && !qrCode) return;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const type = String(dbType || '').toLowerCase();
  const candidateNames = {
    wb: ['Data_Wajib_Belajar', 'Data Santri WB', 'Santri WB', 'Wajib Belajar', 'DB_WB'],
    takhassus: ['Data_Santri_Takhassus', 'Data Santri Takhassus', 'Santri Takhassus', 'Takhassus', 'DB_Takhassus'],
    musyrif: ['Data_Musyrif', 'Data Musyrif', 'Musyrif', 'DB_Musyrif'],
    pengajar: ['Data_Pengajar_Takhassus', 'Data Pengajar', 'Pengajar', 'DB_Pengajar']
  }[type] || [];

  let sheet = null;
  for (let i = 0; i < candidateNames.length; i++) {
    sheet = ss.getSheetByName(candidateNames[i]);
    if (sheet) break;
  }
  if (!sheet || sheet.getLastRow() <= 1) return;

  const colMap = ensureExtraHeaders_(sheet, ['NFC Code', 'QR Code']);
  const targetName = String(data.f1 || '').trim().toLowerCase();
  let targetRow = Number(rowIdx);
  if (!targetRow || targetRow < 2 || targetRow > sheet.getLastRow()) {
    const lastRow = sheet.getLastRow();
    const names = sheet.getRange(2, 1, lastRow - 1, Math.min(3, sheet.getLastColumn())).getValues();
    for (let i = names.length - 1; i >= 0; i--) {
      if (names[i].some(function (c) { return String(c || '').trim().toLowerCase() === targetName; })) {
        targetRow = i + 2;
        break;
      }
    }
  }
  if (targetRow >= 2 && targetRow <= sheet.getLastRow()) {
    if (nfcCode) sheet.getRange(targetRow, colMap['NFC Code']).setValue(nfcCode);
    if (qrCode) sheet.getRange(targetRow, colMap['QR Code']).setValue(qrCode);
  }
}

/**
 * =========================================================================
 * INTEGRASI GOOGLE DRIVE (CADANGAN OTOMATIS GALERI SANTRI, ARSIP SURAT & PROFIL)
 * =========================================================================
 */
const DRIVE_CONFIG_PROP_KEY = 'ALRIFAIE_DRIVE_BACKUP_CONFIG_V1';
const SURAT_DRIVE_MAP_PROP_KEY = 'ALRIFAIE_SURAT_DRIVE_MAP_V1';
const PROFILE_PHOTO_PROP_KEY = 'ALRIFAIE_USER_PROFILE_PHOTOS_V1';
const DEFAULT_DRIVE_ROOT_FOLDER = 'Arsip_Departemen_Pendidikan_AlRifaie';

function getDriveBackupConfig_() {
  const def = {
    enabled: true,
    backupGaleri: true,
    backupSurat: true,
    rootFolderId: '',
    rootFolderName: DEFAULT_DRIVE_ROOT_FOLDER
  };
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(DRIVE_CONFIG_PROP_KEY);
    if (!raw) return def;
    const parsed = JSON.parse(raw);
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : true,
      backupGaleri: typeof parsed.backupGaleri === 'boolean' ? parsed.backupGaleri : true,
      backupSurat: typeof parsed.backupSurat === 'boolean' ? parsed.backupSurat : true,
      rootFolderId: String(parsed.rootFolderId || '').trim(),
      rootFolderName: String(parsed.rootFolderName || DEFAULT_DRIVE_ROOT_FOLDER).trim() || DEFAULT_DRIVE_ROOT_FOLDER
    };
  } catch (e) {
    return def;
  }
}

function getOrCreateDriveRootFolder_() {
  const cfg = getDriveBackupConfig_();
  if (cfg.rootFolderId) {
    try {
      return DriveApp.getFolderById(cfg.rootFolderId);
    } catch (e) {
      Logger.log('Folder ID Drive tidak ditemukan, membuat folder default: ' + e);
    }
  }
  const folderName = cfg.rootFolderName || DEFAULT_DRIVE_ROOT_FOLDER;
  const folders = DriveApp.getFoldersByName(folderName);
  const root = folders.hasNext() ? folders.next() : DriveApp.createFolder(folderName);
  return root;
}

function getOrCreateDriveSubfolder_(subName) {
  const root = getOrCreateDriveRootFolder_();
  if (!subName) return root;
  const subs = root.getFoldersByName(subName);
  return subs.hasNext() ? subs.next() : root.createFolder(subName);
}

function getDriveBackupStatus() {
  try {
    const cfg = getDriveBackupConfig_();
    const root = getOrCreateDriveRootFolder_();
    const galeriFolder = getOrCreateDriveSubfolder_('Galeri_Santri');
    const suratFolder = getOrCreateDriveSubfolder_('Arsip_Surat');
    const countFiles = function (f) {
      let c = 0;
      const it = f.getFiles();
      while (it.hasNext() && c < 500) { it.next(); c++; }
      return c;
    };
    return {
      success: true,
      connected: true,
      config: cfg,
      rootFolderId: root.getId(),
      rootFolderName: root.getName(),
      rootFolderUrl: root.getUrl(),
      galeriFolderUrl: galeriFolder.getUrl(),
      suratFolderUrl: suratFolder.getUrl(),
      galeriCount: countFiles(galeriFolder),
      suratCount: countFiles(suratFolder)
    };
  } catch (err) {
    return {
      success: false,
      connected: false,
      config: getDriveBackupConfig_(),
      error: err && err.message ? err.message : String(err)
    };
  }
}

function saveDriveBackupConfig(payload) {
  const d = payload && typeof payload === 'object' ? payload : {};
  const prev = getDriveBackupConfig_();
  const next = {
    enabled: typeof d.enabled === 'boolean' ? d.enabled : prev.enabled,
    backupGaleri: typeof d.backupGaleri === 'boolean' ? d.backupGaleri : prev.backupGaleri,
    backupSurat: typeof d.backupSurat === 'boolean' ? d.backupSurat : prev.backupSurat,
    rootFolderId: typeof d.rootFolderId === 'string' ? d.rootFolderId.trim() : prev.rootFolderId,
    rootFolderName: (typeof d.rootFolderName === 'string' && d.rootFolderName.trim()) ? d.rootFolderName.trim() : prev.rootFolderName
  };
  PropertiesService.getScriptProperties().setProperty(DRIVE_CONFIG_PROP_KEY, JSON.stringify(next));
  return getDriveBackupStatus();
}

function uploadHdImage(payload) {
  const dataUrl = payload && payload.dataUrl ? String(payload.dataUrl) : '';
  const prefix = payload && payload.prefix ? String(payload.prefix).replace(/[^a-zA-Z0-9_-]/g, '') : 'media';
  const subFolder = payload && payload.subFolder
    ? String(payload.subFolder).replace(/[^a-zA-Z0-9_-]/g, '')
    : (prefix.indexOf('galeri') !== -1 ? 'Galeri_Santri' : (prefix.indexOf('profil') !== -1 ? 'Profil_Pengguna' : 'Media_Aplikasi'));
  if (!dataUrl || dataUrl.indexOf('data:image/') !== 0) {
    return { success: false, error: 'Data gambar tidak valid.' };
  }
  const saved = saveHdImageToDrive_(dataUrl, prefix, subFolder);
  return { success: true, url: saved.url, viewUrl: saved.viewUrl, fileId: saved.fileId, folderName: subFolder };
}

function saveHdImageToDrive_(dataUrl, prefix, subFolderName) {
  const match = String(dataUrl).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) {
    throw new Error('Format data URL gambar tidak dikenali.');
  }
  const mimeType = match[1];
  const base64Body = match[2];
  const ext = mimeType.indexOf('png') !== -1 ? 'png' : (mimeType.indexOf('webp') !== -1 ? 'webp' : 'jpg');
  const bytes = Utilities.base64Decode(base64Body);
  const fileName = (prefix || 'media') + '_' + Date.now() + '.' + ext;
  const blob = Utilities.newBlob(bytes, mimeType, fileName);

  const folder = getOrCreateDriveSubfolder_(subFolderName || 'Galeri_Santri');
  const file = folder.createFile(blob);
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (shareErr) {
    Logger.log('Info sharing Drive file: ' + shareErr);
  }
  const fileId = file.getId();
  return {
    fileId: fileId,
    url: 'https://lh3.googleusercontent.com/d/' + fileId + '=w1600',
    viewUrl: 'https://drive.google.com/file/d/' + fileId + '/view',
    fileName: fileName
  };
}

function normalizeSuratDriveKey_(nomor, perihal) {
  return (String(nomor || '').trim().toLowerCase() + '|' + String(perihal || '').trim().toLowerCase()).slice(0, 120);
}

function readSuratDriveMap_() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(SURAT_DRIVE_MAP_PROP_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (e) {
    return {};
  }
}

function saveSuratDriveMapEntry_(key, meta) {
  try {
    const props = PropertiesService.getScriptProperties();
    const map = readSuratDriveMap_();
    map[key] = meta;
    const keys = Object.keys(map);
    if (keys.length > 120) {
      keys.slice(0, keys.length - 120).forEach(function (oldK) { delete map[oldK]; });
    }
    props.setProperty(SURAT_DRIVE_MAP_PROP_KEY, JSON.stringify(map));
  } catch (e) {
    Logger.log('Info simpan surat drive map: ' + e);
  }
}

function backupSuratHtmlToDriveInternal_(suratPayload, htmlSnapshot) {
  const nomor = String(suratPayload.nomor || ('Surat_' + Date.now())).trim();
  const perihal = String(suratPayload.perihal || 'Dokumen_Surat').trim();
  const safeBase = ('Surat_' + nomor + '_' + perihal).replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80);
  const fullHtml = htmlSnapshot && htmlSnapshot.length > 40
    ? ('<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:Times New Roman,serif;margin:0;padding:12mm;color:#111;background:#fff;}</style></head><body>' + htmlSnapshot + '</body></html>')
    : ('<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:serif;padding:24px;"><h2>' + perihal + '</h2><p><b>Nomor:</b> ' + nomor + '</p><p><b>Kategori:</b> ' + String(suratPayload.kategori || '-') + '</p><p><b>Tujuan:</b> ' + String(suratPayload.tujuan || '-') + '</p></body></html>');

  const folder = getOrCreateDriveSubfolder_('Arsip_Surat');
  let file = null;
  try {
    const htmlBlob = Utilities.newBlob(fullHtml, 'text/html', safeBase + '.html');
    const pdfBlob = htmlBlob.getAs(MimeType.PDF).setName(safeBase + '.pdf');
    file = folder.createFile(pdfBlob);
  } catch (pdfErr) {
    const fallbackBlob = Utilities.newBlob(fullHtml, 'text/html', safeBase + '.html');
    file = folder.createFile(fallbackBlob);
  }
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (shareErr) {}

  const meta = {
    fileId: file.getId(),
    viewUrl: 'https://drive.google.com/file/d/' + file.getId() + '/view',
    fileName: file.getName(),
    backupAt: new Date().toISOString()
  };
  saveSuratDriveMapEntry_(normalizeSuratDriveKey_(nomor, perihal), meta);
  return meta;
}

function backupSuratPdfToDrive(payload) {
  try {
    const cfg = getDriveBackupConfig_();
    if (!cfg.enabled || !cfg.backupSurat) {
      return { success: false, skipped: true, message: 'Backup otomatis surat ke Drive sedang dinonaktifkan.' };
    }
    const d = payload && typeof payload === 'object' ? payload : {};
    const meta = backupSuratHtmlToDriveInternal_(d, String(d.html || d.driveHtmlSnapshot || ''));
    return {
      success: true,
      fileId: meta.fileId,
      driveUrl: meta.viewUrl,
      fileName: meta.fileName
    };
  } catch (err) {
    return { success: false, error: err && err.message ? err.message : String(err) };
  }
}

function getUserProfilePhoto(userKey) {
  try {
    const key = String(userKey || '').trim().toLowerCase();
    if (!key) return { success: true, photoUrl: '' };
    const raw = PropertiesService.getScriptProperties().getProperty(PROFILE_PHOTO_PROP_KEY);
    const map = raw ? JSON.parse(raw) : {};
    return { success: true, photoUrl: (map && map[key]) ? String(map[key]) : '' };
  } catch (e) {
    return { success: false, photoUrl: '' };
  }
}

function saveUserProfilePhoto(payload) {
  try {
    const d = payload && typeof payload === 'object' ? payload : {};
    const key = String(d.userKey || '').trim().toLowerCase();
    if (!key) return { success: false, message: 'Kunci pengguna tidak valid.' };
    const raw = PropertiesService.getScriptProperties().getProperty(PROFILE_PHOTO_PROP_KEY);
    const map = raw ? JSON.parse(raw) : {};
    if (d.remove === true || !d.dataUrl) {
      delete map[key];
      PropertiesService.getScriptProperties().setProperty(PROFILE_PHOTO_PROP_KEY, JSON.stringify(map));
      return { success: true, photoUrl: '' };
    }
    let finalUrl = String(d.dataUrl);
    if (finalUrl.indexOf('data:image/') === 0) {
      const saved = saveHdImageToDrive_(finalUrl, 'profil_' + key.replace(/[^a-z0-9]/g, '_').slice(0, 24), 'Profil_Pengguna');
      finalUrl = saved.url;
    }
    map[key] = finalUrl;
    PropertiesService.getScriptProperties().setProperty(PROFILE_PHOTO_PROP_KEY, JSON.stringify(map));
    return { success: true, photoUrl: finalUrl };
  } catch (err) {
    return { success: false, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * Mendapatkan / membuat otomatis sheet "SyncLog" untuk catatan idempotency.
 */
function getOrCreateSyncLogSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SYNC_LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SYNC_LOG_SHEET_NAME);
    sheet.appendRow(['ClientOpId', 'Action', 'Status', 'SyncedAt']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function isOpAlreadySynced_(clientOpId) {
  if (!clientOpId) return false;
  const cache = CacheService.getScriptCache();
  if (cache.get('sync_' + clientOpId)) return true;

  const sheet = getOrCreateSyncLogSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return false;

  const startRow = Math.max(2, lastRow - 1000);
  const values = sheet.getRange(startRow, 1, lastRow - startRow + 1, 1).getValues();
  for (let i = values.length - 1; i >= 0; i--) {
    if (String(values[i][0]) === clientOpId) {
      cache.put('sync_' + clientOpId, '1', 21600);
      return true;
    }
  }
  return false;
}

function recordSyncedOp_(clientOpId, fnName, status) {
  if (!clientOpId) return;
  const sheet = getOrCreateSyncLogSheet_();
  sheet.appendRow([clientOpId, fnName, status, new Date().toISOString()]);
  CacheService.getScriptCache().put('sync_' + clientOpId, '1', 21600);
}

function createJsonOutput_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * =========================================================================
 * MANAJEMEN AKUN & AUTENTIKASI WALI SANTRI (HASH SHA-256 BERSALT)
 * =========================================================================
 */
const WALI_SANTRI_PROP_KEY = 'ALRIFAIE_WALI_SANTRI_USERS_V1';

function readWaliSantriStore_() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(WALI_SANTRI_PROP_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function writeWaliSantriStore_(list) {
  PropertiesService.getScriptProperties().setProperty(WALI_SANTRI_PROP_KEY, JSON.stringify(list || []));
}

function computeSaltedSha256_(password, salt) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(salt || '') + ':' + String(password || ''),
    Utilities.Charset.UTF_8
  );
  return bytes.map(function (b) {
    const v = b < 0 ? b + 256 : b;
    return (v < 16 ? '0' : '') + v.toString(16);
  }).join('');
}

function timingSafeHexEqual_(a, b) {
  const sa = String(a || '');
  const sb = String(b || '');
  if (!sa || sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) {
    diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  }
  return diff === 0;
}

function getWaliSantriUsers() {
  const list = readWaliSantriStore_();
  return list.map(function (u) {
    return {
      id: String(u.id || ''),
      username: String(u.username || ''),
      namaWali: String(u.namaWali || ''),
      namaSantri: String(u.namaSantri || ''),
      akses: Array.isArray(u.akses) ? u.akses : [],
      createdAt: u.createdAt || ''
    };
  });
}

function saveWaliSantriUser(payload) {
  const lock = LockService.getScriptLock();
  if (!tryAcquireLock_(lock, 15000)) {
    return { success: false, busy: true, message: 'Server sedang sibuk, silakan coba sesaat lagi.' };
  }
  try {
    const data = payload && typeof payload === 'object' ? payload : {};
    const id = String(data.id || '').trim();
    const username = String(data.username || '').trim();
    const password = String(data.password || '');
    const namaWali = String(data.namaWali || '').trim();
    const namaSantri = String(data.namaSantri || '').trim();
    const sharedSingle = Boolean(data.sharedSingle);
    const allowedPermKeys = ['wb', 'takhassus', 'musyrif', 'pengajar', 'rekap', 'tunggakan', 'simpanan', 'operasional', 'surat', 'saranAdmin', 'database', 'admin'];
    const akses = Array.isArray(data.akses)
      ? data.akses.map(function (x) { return String(x); }).filter(function (k) { return allowedPermKeys.indexOf(k) !== -1; })
      : [];

    if (!username || username.length < 3) {
      return { success: false, message: 'Username Wali Santri minimal 3 karakter.' };
    }

    const list = readWaliSantriStore_();

    if (sharedSingle) {
      const existing = list.find(function (x) { return String(x.id) === 'wali_shared_main' || x.sharedSingle; }) || list[0] || null;
      let nextSalt = existing && existing.salt ? existing.salt : '';
      let nextHash = existing && existing.passwordHash ? existing.passwordHash : '';
      if (password) {
        if (password.length < 4) {
          return { success: false, message: 'Password minimal 4 karakter.' };
        }
        nextSalt = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
        nextHash = computeSaltedSha256_(password, nextSalt);
      } else if (data.passwordHash && data.salt) {
        nextSalt = String(data.salt);
        nextHash = String(data.passwordHash);
      }
      if (!nextHash || !nextSalt) {
        return { success: false, message: 'Password wajib diisi untuk akun bersama Wali Santri.' };
      }
      const sharedId = 'wali_shared_main';
      const sharedRecord = {
        id: sharedId,
        username: username,
        namaWali: namaWali || 'Wali Santri',
        namaSantri: '',
        akses: akses,
        salt: nextSalt,
        passwordHash: nextHash,
        sharedSingle: true,
        createdAt: (existing && existing.createdAt) || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      writeWaliSantriStore_([sharedRecord]);
      return { success: true, id: sharedId };
    }

    const dupIdx = list.findIndex(function (x) {
      return String(x.username || '').toLowerCase() === username.toLowerCase() && String(x.id) !== id;
    });
    if (dupIdx !== -1) {
      return { success: false, message: 'Username sudah digunakan oleh akun Wali Santri lain.' };
    }

    if (id) {
      const idx = list.findIndex(function (x) { return String(x.id) === id; });
      if (idx === -1) {
        return { success: false, message: 'Akun Wali Santri tidak ditemukan.' };
      }
      const existing = list[idx];
      let nextSalt = existing.salt || '';
      let nextHash = existing.passwordHash || '';
      if (password) {
        if (password.length < 4) {
          return { success: false, message: 'Password minimal 4 karakter.' };
        }
        nextSalt = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
        nextHash = computeSaltedSha256_(password, nextSalt);
      } else if (data.passwordHash && data.salt) {
        nextSalt = String(data.salt);
        nextHash = String(data.passwordHash);
      }
      list[idx] = {
        id: existing.id,
        username: username,
        namaWali: namaWali || username,
        namaSantri: namaSantri,
        akses: akses,
        salt: nextSalt,
        passwordHash: nextHash,
        createdAt: existing.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      writeWaliSantriStore_(list);
      return { success: true, id: existing.id };
    }

    if (!password && !(data.passwordHash && data.salt)) {
      return { success: false, message: 'Password wajib diisi untuk akun Wali Santri baru.' };
    }
    if (password && password.length < 4) {
      return { success: false, message: 'Password minimal 4 karakter.' };
    }

    const newId = 'ws_' + Date.now() + '_' + Utilities.getUuid().slice(0, 6);
    const salt = password ? Utilities.getUuid().replace(/-/g, '').slice(0, 16) : String(data.salt);
    const passwordHash = password ? computeSaltedSha256_(password, salt) : String(data.passwordHash);

    list.push({
      id: newId,
      username: username,
      namaWali: namaWali || username,
      namaSantri: namaSantri,
      akses: akses,
      salt: salt,
      passwordHash: passwordHash,
      createdAt: new Date().toISOString()
    });
    writeWaliSantriStore_(list);
    return { success: true, id: newId };
  } finally {
    lock.releaseLock();
  }
}

function deleteWaliSantriUser(id) {
  const lock = LockService.getScriptLock();
  if (!tryAcquireLock_(lock, 15000)) {
    return { success: false, busy: true, message: 'Server sedang sibuk, silakan coba sesaat lagi.' };
  }
  try {
    const targetId = String(id || '').trim();
    if (!targetId) return { success: false, message: 'ID akun tidak valid.' };
    const list = readWaliSantriStore_().filter(function (x) { return String(x.id) !== targetId; });
    writeWaliSantriStore_(list);
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

function verifyWaliSantriLogin(username, password) {
  const uname = String(username || '').trim().toLowerCase();
  const pwd = String(password || '');
  if (!uname || !pwd) {
    return { success: false, message: 'Username dan password wajib diisi.' };
  }
  const list = readWaliSantriStore_();
  const acc = list.find(function (x) { return String(x.username || '').trim().toLowerCase() === uname; });
  if (!acc || !acc.passwordHash || !acc.salt) {
    return { success: false, message: 'Username atau password Wali Santri tidak sesuai.' };
  }
  const candidateHash = computeSaltedSha256_(pwd, acc.salt);
  if (!timingSafeHexEqual_(candidateHash, acc.passwordHash)) {
    return { success: false, message: 'Username atau password Wali Santri tidak sesuai.' };
  }

  let defaultWaliPerms = ['rekap'];
  try {
    const rawRp = PropertiesService.getScriptProperties().getProperty('ALRIFAIE_ROLE_PERMISSIONS');
    if (rawRp) {
      const rp = JSON.parse(rawRp);
      if (Array.isArray(rp.walisantri)) defaultWaliPerms = rp.walisantri;
    }
  } catch (e) {}

  const perms = Array.isArray(acc.akses) ? acc.akses : defaultWaliPerms;
  return {
    success: true,
    role: 'walisantri',
    username: acc.username,
    name: acc.namaWali || acc.username,
    namaSantri: acc.namaSantri || '',
    jabatan: acc.namaSantri ? ('Wali • ' + acc.namaSantri) : 'Wali Santri',
    permissions: perms
  };
}

/**
 * =========================================================================
 * IZIN DIGITAL (SAKIT / PULANG / DISPENSASI) & PERSETUJUAN PENGURUS
 * =========================================================================
 */
const IZIN_DIGITAL_SHEET_NAME = 'IzinDigital';
const TINDAKAN_SANTRI_SHEET_NAME = 'TindakanSantri';

function getOrCreateIzinSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(IZIN_DIGITAL_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(IZIN_DIGITAL_SHEET_NAME);
    sh.appendRow(['ID', 'NamaSantri', 'KamarKelas', 'Jenis', 'Mulai', 'Selesai', 'Alasan', 'Pengaju', 'PeranPengaju', 'Status', 'DiprosesOleh', 'CatatanAdmin', 'CreatedAt']);
    sh.setFrozenRows(1);
  }
  return sh;
}

function getIzinDigital() {
  try {
    const sh = getOrCreateIzinSheet_();
    const lastRow = sh.getLastRow();
    if (lastRow <= 1) return [];
    const rows = sh.getRange(2, 1, lastRow - 1, 13).getValues();
    const out = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (!r[0]) continue;
      out.push({
        id: String(r[0]),
        namaSantri: String(r[1] || ''),
        kamarKelas: String(r[2] || ''),
        jenis: String(r[3] || 'Sakit'),
        startDate: String(r[4] || ''),
        endDate: String(r[5] || ''),
        alasan: String(r[6] || ''),
        pengaju: String(r[7] || ''),
        peranPengaju: String(r[8] || ''),
        status: String(r[9] || 'Menunggu'),
        diprosesOleh: String(r[10] || ''),
        catatanAdmin: String(r[11] || ''),
        createdAt: String(r[12] || '')
      });
    }
    return out;
  } catch (e) {
    return [];
  }
}

function safeSheetCell_(val, maxLen) {
  const s = String(val == null ? '' : val).trim().slice(0, maxLen || 300);
  if (/^[=+\-@\t\r]/.test(s)) return "'" + s;
  return s;
}

function saveIzinDigital(payload) {
  const lock = LockService.getScriptLock();
  if (!tryAcquireLock_(lock, 15000)) {
    return { success: false, busy: true, message: 'Server sedang sibuk, silakan coba sesaat lagi.' };
  }
  try {
    const d = payload && typeof payload === 'object' ? payload : {};
    const namaPemohon = safeSheetCell_(d.namaSantri || d.namaPemohon, 120);
    const unitTugas = safeSheetCell_(d.kamarKelas || d.unitTugas, 100);
    const allowedJenis = ['Sakit', 'Keperluan Keluarga', 'Tugas Luar / Dinas', 'Izin Pribadi', 'Pulang', 'Dispensasi'];
    const jenis = allowedJenis.indexOf(String(d.jenis || '')) !== -1 ? String(d.jenis) : 'Izin Pribadi';
    const startDate = String(d.startDate || '').trim().slice(0, 10);
    const endDate = String(d.endDate || startDate).trim().slice(0, 10);
    const alasan = safeSheetCell_(d.alasan, 400);
    const pengaju = safeSheetCell_(d.pengaju || namaPemohon, 100);
    const peranPengaju = String(d.peranPengaju || '').trim().toLowerCase();

    if (['musyrif', 'pengajar', 'admin'].indexOf(peranPengaju) === -1) {
      return { success: false, message: 'Izin Digital hanya diperuntukkan bagi Musyrif, Pengajar, atau Admin.' };
    }
    if (!namaPemohon || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || endDate < startDate) {
      return { success: false, message: 'Nama pemohon dan rentang tanggal izin wajib valid.' };
    }

    const sh = getOrCreateIzinSheet_();
    const id = String(d.id || ('iz_' + Date.now() + '_' + Utilities.getUuid().slice(0, 6))).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60);
    let initialStatus = (peranPengaju === 'admin') ? 'Disetujui' : 'Menunggu';
    let diprosesOleh = (peranPengaju === 'admin') ? pengaju : '';
    let catatanAdmin = safeSheetCell_(d.catatanAdmin || '', 300);
    let autoRejected = false;

    // Validasi batas waktu Izin Digital yang diatur Admin (WIB): otomatis tertolak jika melewati batas waktu
    if (peranPengaju !== 'admin') {
      try {
        const rawDl = PropertiesService.getScriptProperties().getProperty('ALRIFAIE_ATTENDANCE_DEADLINES');
        const dlCfg = rawDl ? JSON.parse(rawDl) : null;
        const izinCfg = dlCfg && dlCfg.izinDigital ? dlCfg.izinDigital : { enabled: true, time: '16:00' };
        if (izinCfg && izinCfg.enabled && /^\d{2}:\d{2}$/.test(String(izinCfg.time || ''))) {
          const nowDate = new Date();
          const todayWib = Utilities.formatDate(nowDate, 'Asia/Jakarta', 'yyyy-MM-dd');
          const nowTimeWib = Utilities.formatDate(nowDate, 'Asia/Jakarta', 'HH:mm');
          if (startDate < todayWib || (startDate === todayWib && nowTimeWib > String(izinCfg.time))) {
            initialStatus = 'Ditolak';
            diprosesOleh = 'Sistem (Otomatis)';
            catatanAdmin = 'Ditolak otomatis: melewati batas waktu pengajuan izin (' + izinCfg.time + ' WIB).';
            autoRejected = true;
          }
        }
      } catch (dlErr) {
        Logger.log('Info cek batas izin digital: ' + dlErr);
      }
    }

    const createdAt = new Date().toISOString();
    sh.appendRow([id, namaPemohon, unitTugas, jenis, startDate, endDate, alasan, pengaju, peranPengaju, initialStatus, diprosesOleh, catatanAdmin, createdAt]);
    return { success: true, id: id, status: initialStatus, autoRejected: autoRejected, diprosesOleh: diprosesOleh, catatanAdmin: catatanAdmin };
  } finally {
    lock.releaseLock();
  }
}

function updateIzinDigitalStatus(id, nextStatus, approverName, catatanAdmin) {
  const lock = LockService.getScriptLock();
  if (!tryAcquireLock_(lock, 15000)) {
    return { success: false, busy: true, message: 'Server sedang sibuk, silakan coba sesaat lagi.' };
  }
  try {
    const targetId = String(id || '').trim();
    const allowedStatuses = ['Menunggu', 'Disetujui', 'Ditolak'];
    if (!targetId || allowedStatuses.indexOf(String(nextStatus || '')) === -1) {
      return { success: false, message: 'Parameter status izin tidak valid.' };
    }
    const sh = getOrCreateIzinSheet_();
    const lastRow = sh.getLastRow();
    if (lastRow <= 1) return { success: false, message: 'Data izin tidak ditemukan.' };
    const ids = sh.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === targetId) {
        const rowNum = i + 2;
        sh.getRange(rowNum, 10).setValue(String(nextStatus));
        sh.getRange(rowNum, 11).setValue(safeSheetCell_(approverName, 100));
        sh.getRange(rowNum, 12).setValue(safeSheetCell_(catatanAdmin, 300));
        return { success: true };
      }
    }
    return { success: false, message: 'Data izin tidak ditemukan.' };
  } finally {
    lock.releaseLock();
  }
}

function deleteIzinDigital(id) {
  const lock = LockService.getScriptLock();
  if (!tryAcquireLock_(lock, 15000)) {
    return { success: false, busy: true, message: 'Server sedang sibuk, silakan coba sesaat lagi.' };
  }
  try {
    const targetId = String(id || '').trim();
    if (!targetId) return { success: false, message: 'ID izin tidak valid.' };
    const sh = getOrCreateIzinSheet_();
    const lastRow = sh.getLastRow();
    if (lastRow <= 1) return { success: true };
    const ids = sh.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = ids.length - 1; i >= 0; i--) {
      if (String(ids[i][0]) === targetId) {
        sh.deleteRow(i + 2);
        return { success: true };
      }
    }
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * =========================================================================
 * LOG TINDAKAN MUSYRIF / PENGAJAR UNTUK SANTRI BERMASALAH
 * =========================================================================
 */
function getOrCreateTindakanSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(TINDAKAN_SANTRI_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(TINDAKAN_SANTRI_SHEET_NAME);
    sh.appendRow(['ID', 'Tanggal', 'NamaSantri', 'KamarKelas', 'Tindakan', 'Catatan', 'Petugas', 'PeranPetugas']);
    sh.setFrozenRows(1);
  }
  return sh;
}

function getSantriTindakan() {
  try {
    const sh = getOrCreateTindakanSheet_();
    const lastRow = sh.getLastRow();
    if (lastRow <= 1) return [];
    const rows = sh.getRange(2, 1, lastRow - 1, 8).getValues();
    const out = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (!r[0]) continue;
      out.push({
        id: String(r[0]),
        tanggal: String(r[1] || ''),
        namaSantri: String(r[2] || ''),
        kamarKelas: String(r[3] || ''),
        tindakan: String(r[4] || ''),
        catatan: String(r[5] || ''),
        petugas: String(r[6] || ''),
        peranPetugas: String(r[7] || '')
      });
    }
    return out;
  } catch (e) {
    return [];
  }
}

function saveSantriTindakan(payload) {
  const lock = LockService.getScriptLock();
  if (!tryAcquireLock_(lock, 15000)) {
    return { success: false, busy: true, message: 'Server sedang sibuk, silakan coba sesaat lagi.' };
  }
  try {
    const d = payload && typeof payload === 'object' ? payload : {};
    const namaSantri = safeSheetCell_(d.namaSantri, 120);
    const tindakan = safeSheetCell_(d.tindakan, 120);
    if (!namaSantri || !tindakan) {
      return { success: false, message: 'Nama santri dan jenis tindakan wajib diisi.' };
    }
    const sh = getOrCreateTindakanSheet_();
    const id = String(d.id || ('tnd_' + Date.now() + '_' + Utilities.getUuid().slice(0, 6))).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60);
    const rawDate = String(d.tanggal || '').trim().slice(0, 10);
    const tanggal = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : new Date().toISOString().slice(0, 10);
    sh.appendRow([
      id,
      tanggal,
      namaSantri,
      safeSheetCell_(d.kamarKelas, 100),
      tindakan,
      safeSheetCell_(d.catatan, 400),
      safeSheetCell_(d.petugas, 100),
      safeSheetCell_(d.peranPetugas, 40)
    ]);
    return { success: true, id: id };
  } finally {
    lock.releaseLock();
  }
}
