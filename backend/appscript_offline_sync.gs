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
function syncOfflineBatch(items) {
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
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
  lock.waitLock(20000);
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

  // Otomatis simpan gambar HD (data:image/...) ke Google Drive agar Google Sheet hanya menyimpan URL HD tajam
  const safeArgs = Array.isArray(args) ? args.slice() : [];
  if (fnName === 'saveGaleriData' && safeArgs[0] && typeof safeArgs[0] === 'object') {
    const item = Object.assign({}, safeArgs[0]);
    if (typeof item.imageUrl === 'string' && item.imageUrl.indexOf('data:image/') === 0 && item.imageUrl.length > 48000) {
      const up = saveHdImageToDrive_(item.imageUrl, 'galeri');
      if (up && up.url) item.imageUrl = up.url;
    }
    safeArgs[0] = item;
  } else if (fnName === 'updateAppSettings' && safeArgs[0] && typeof safeArgs[0] === 'object') {
    const cfg = Object.assign({}, safeArgs[0]);
    if (typeof cfg.bannerUrl === 'string' && cfg.bannerUrl.indexOf('data:image/') === 0 && cfg.bannerUrl.length > 48000) {
      const upBanner = saveHdImageToDrive_(cfg.bannerUrl, 'banner');
      if (upBanner && upBanner.url) cfg.bannerUrl = upBanner.url;
    }
    if (typeof cfg.logoUrl === 'string' && cfg.logoUrl.indexOf('data:image/') === 0 && cfg.logoUrl.length > 48000) {
      const upLogo = saveHdImageToDrive_(cfg.logoUrl, 'logo');
      if (upLogo && upLogo.url) cfg.logoUrl = upLogo.url;
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
  return targetFn.apply(null, safeArgs);
}

/**
 * Mengunggah gambar Full-HD ke Google Drive ("AlRifaie_HD_Media") dan mengembalikan
 * URL CDN tajam (lh3.googleusercontent.com/d/<ID>=w1920) tanpa batas 50.000 karakter sel Sheet.
 */
function uploadHdImage(payload) {
  const dataUrl = payload && payload.dataUrl ? String(payload.dataUrl) : '';
  const prefix = payload && payload.prefix ? String(payload.prefix).replace(/[^a-zA-Z0-9_-]/g, '') : 'media';
  if (!dataUrl || dataUrl.indexOf('data:image/') !== 0) {
    return { success: false, error: 'Data gambar tidak valid.' };
  }
  const saved = saveHdImageToDrive_(dataUrl, prefix);
  return { success: true, url: saved.url, fileId: saved.fileId };
}

function saveHdImageToDrive_(dataUrl, prefix) {
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

  const folderName = 'AlRifaie_HD_Media';
  const folders = DriveApp.getFoldersByName(folderName);
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(folderName);
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  const fileId = file.getId();
  return {
    fileId: fileId,
    url: 'https://lh3.googleusercontent.com/d/' + fileId + '=w1920'
  };
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
