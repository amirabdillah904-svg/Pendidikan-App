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
  const result = targetFn.apply(null, safeArgs);

  // Sisipkan batas waktu absen & hak akses peran ke respons settings secara otomatis
  try {
    if ((fnName === 'getInitialBundle' || fnName === 'getFastLoginData') && result && typeof result === 'object') {
      const props = PropertiesService.getScriptProperties();
      const rawDl = props.getProperty('ALRIFAIE_ATTENDANCE_DEADLINES');
      const rawRp = props.getProperty('ALRIFAIE_ROLE_PERMISSIONS');
      const rawSp = props.getProperty('ALRIFAIE_STAFF_PERM_OVERRIDES');
      if (rawDl || rawRp || rawSp) {
        result.settings = result.settings && typeof result.settings === 'object' ? result.settings : {};
        if (rawDl) result.settings.attendanceDeadlines = JSON.parse(rawDl);
        if (rawRp) result.settings.rolePermissions = JSON.parse(rawRp);
        if (rawSp) result.settings.staffPermissionOverrides = JSON.parse(rawSp);
      }
    }
  } catch (mergeErr) {
    Logger.log('Info merge extra settings: ' + mergeErr);
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
    wb: ['Absensi WB', 'Absensi Wajib Belajar', 'Rekap WB', 'Log Absensi WB'],
    takhassus: ['Absensi Takhassus', 'Rekap Takhassus', 'Log Absensi Takhassus'],
    musyrif: ['Absensi Musyrif', 'Rekap Musyrif', 'Log Absensi Musyrif'],
    pengajar: ['Absensi Pengajar', 'Rekap Pengajar', 'Log Absensi Pengajar']
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
    wb: ['Data Santri WB', 'Santri WB', 'Wajib Belajar', 'DB_WB'],
    takhassus: ['Data Santri Takhassus', 'Santri Takhassus', 'Takhassus', 'DB_Takhassus'],
    musyrif: ['Data Musyrif', 'Musyrif', 'DB_Musyrif'],
    pengajar: ['Data Pengajar', 'Pengajar', 'DB_Pengajar']
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
  lock.waitLock(15000);
  try {
    const data = payload && typeof payload === 'object' ? payload : {};
    const id = String(data.id || '').trim();
    const username = String(data.username || '').trim();
    const password = String(data.password || '');
    const namaWali = String(data.namaWali || '').trim();
    const namaSantri = String(data.namaSantri || '').trim();
    const allowedPermKeys = ['wb', 'takhassus', 'musyrif', 'pengajar', 'izin', 'rekap', 'tunggakan', 'simpanan', 'operasional', 'surat', 'saranAdmin', 'database', 'admin'];
    const akses = Array.isArray(data.akses)
      ? data.akses.map(function (x) { return String(x); }).filter(function (k) { return allowedPermKeys.indexOf(k) !== -1; })
      : [];

    if (!username || username.length < 3) {
      return { success: false, message: 'Username Wali Santri minimal 3 karakter.' };
    }

    const list = readWaliSantriStore_();
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
  lock.waitLock(15000);
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
  lock.waitLock(15000);
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
    const initialStatus = (peranPengaju === 'admin') ? 'Disetujui' : 'Menunggu';
    const diprosesOleh = (peranPengaju === 'admin') ? pengaju : '';
    const createdAt = new Date().toISOString();

    sh.appendRow([id, namaPemohon, unitTugas, jenis, startDate, endDate, alasan, pengaju, peranPengaju, initialStatus, diprosesOleh, '', createdAt]);
    return { success: true, id: id, status: initialStatus };
  } finally {
    lock.releaseLock();
  }
}

function updateIzinDigitalStatus(id, nextStatus, approverName, catatanAdmin) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
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
  lock.waitLock(15000);
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
  lock.waitLock(15000);
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
