/**
 * =========================================================================
 * BACKEND TERPADU GOOGLE APPS SCRIPT (SINGLE-FILE DROP-IN)
 * Departemen Pendidikan - YPM Al-Rifa'ie 2
 * =========================================================================
 * Terintegrasi penuh dengan APK Android & PWA:
 * 1. Adapter JSONP (doGet) + POST JSON + Offline-First Batch Sync (`syncOfflineBatch`)
 *    dengan proteksi Anti-Duplikat (`SyncLog` + `LockService`)
 * 2. Absensi NFC & QR Code Real-Time (Single-Scan Upsert + Edit Pelanggaran
 *    tanpa mengunci sesi kamar/kelas sebelum finalisasi)
 * 3. Integrasi Google Drive Otomatis (Galeri Santri, Arsip Surat / Surat SP PDF,
 *    Foto Profil Pengguna, Logo & Banner Aplikasi) agar bebas limit 50.000 karakter Sheet
 * 4. Izin Digital (Musyrif / Pengajar / Admin) dengan penolakan otomatis lewat batas waktu WIB
 * 5. Manajemen Akun Wali Santri (Hash SHA-256 bersalt), Hak Akses Peran & Override Staf
 * 6. Log Tindakan Santri, Arsip Surat SP, Edit Foto Profil Lintas Perangkat
 * 7. Server-side CacheService + Fallback Anti-Error untuk Tunggakan & Rekap Cepat
 *
 * CARA DEPLOY DI GOOGLE APPS SCRIPT:
 * 1. Buka proyek Google Apps Script yang terhubung ke Google Spreadsheet Anda.
 * 2. Ganti seluruh isi file `Code.gs` dengan isi file ini (hapus file duplikat seperti
 *    `OfflineSync.gs` jika sebelumnya pernah menambahkannya agar tidak bentrok `doGet`/`doPost`).
 * 3. (Opsional sekali di awal) Pilih fungsi `testAuthorizationAndSetup` -> klik Run
 *    untuk menyetujui izin Google Sheets & Google Drive.
 * 4. Klik Deploy -> Manage deployments -> Edit (ikon pensil) -> pilih "New version" -> Deploy.
 *    Pastikan Execute as: Me, Who has access: Anyone.
 * =========================================================================
 */

const TIMEZONE_WIB = 'Asia/Jakarta';
const SYNC_LOG_SHEET_NAME = 'SyncLog';
const IZIN_DIGITAL_SHEET_NAME = 'IzinDigital';
const TINDAKAN_SANTRI_SHEET_NAME = 'TindakanSantri';
const WALI_SANTRI_SHEET_NAME = 'Akun_Wali_Santri';
const PROFILE_PHOTO_SHEET_NAME = 'Foto_Profil';

const WALI_SANTRI_PROP_KEY = 'ALRIFAIE_WALI_SANTRI_USERS_V1';
const DRIVE_CONFIG_PROP_KEY = 'ALRIFAIE_DRIVE_BACKUP_CONFIG_V1';
const SURAT_DRIVE_MAP_PROP_KEY = 'ALRIFAIE_SURAT_DRIVE_MAP_V1';
const PROFILE_PHOTO_PROP_KEY = 'ALRIFAIE_USER_PROFILE_PHOTOS_V1';
const DEFAULT_DRIVE_ROOT_FOLDER = 'Arsip_Departemen_Pendidikan_AlRifaie';
const SCHEMA_READY_CACHE_KEY = 'ALRIFAIE_SCHEMA_READY_V22';

// Skema lengkap semua sheet & kolom wajib aplikasi (otomatis dibuat jika belum ada)
const APP_SHEET_SCHEMAS_ = {
  Settings: {
    headers: ['Key', 'Value'],
    extra: []
  },
  Data_Users: {
    headers: ['ID', 'Username', 'PIN', 'Jabatan', 'Akses_Fitur'],
    extra: []
  },
  Akun_Wali_Santri: {
    headers: ['ID', 'Username', 'NamaWali', 'NamaSantri', 'Akses', 'SharedSingle', 'Salt', 'PasswordHash', 'CreatedAt', 'UpdatedAt'],
    extra: ['SharedSingle', 'Salt', 'PasswordHash', 'CreatedAt', 'UpdatedAt']
  },
  Foto_Profil: {
    headers: ['UserKey', 'Nama', 'Peran', 'PhotoURL', 'UpdatedAt'],
    extra: ['Nama', 'Peran', 'PhotoURL', 'UpdatedAt']
  },
  Data_Wajib_Belajar: {
    headers: ['Nama', 'Kamar', 'NFC Code', 'QR Code'],
    extra: ['NFC Code', 'QR Code']
  },
  Data_Santri_Takhassus: {
    headers: ['No', 'Nama', 'Kelas', 'Qismu', 'NFC Code', 'QR Code'],
    extra: ['NFC Code', 'QR Code']
  },
  Data_Musyrif: {
    headers: ['Nama', 'Kamar', 'PIN', 'NFC Code', 'QR Code'],
    extra: ['PIN', 'NFC Code', 'QR Code']
  },
  Data_Pengajar_Takhassus: {
    headers: ['No', 'Nama', 'Kelas', 'Qismu', 'PIN', 'NFC Code', 'QR Code'],
    extra: ['PIN', 'NFC Code', 'QR Code']
  },
  Log_Absensi_WB: {
    headers: [
      'ID_Sesi', 'Timestamp', 'Tgl_Sesi', 'Tahun', 'Bulan',
      'Role', 'Petugas', 'Target', 'Nama', 'Kehadiran',
      'Pelanggaran/Keterangan', 'Poin', 'NFC Code', 'QR Code', 'Metode', 'Waktu_Scan'
    ],
    extra: ['NFC Code', 'QR Code', 'Metode', 'Waktu_Scan']
  },
  Log_Absensi_Takhassus: {
    headers: [
      'ID_Sesi', 'Timestamp', 'Tgl_Sesi', 'Tahun', 'Bulan',
      'Role', 'Petugas', 'Target', 'Nama', 'Kehadiran',
      'Pelanggaran/Keterangan', 'Poin', 'NFC Code', 'QR Code', 'Metode', 'Waktu_Scan'
    ],
    extra: ['NFC Code', 'QR Code', 'Metode', 'Waktu_Scan']
  },
  Log_Absensi_Musyrif: {
    headers: [
      'ID_Sesi', 'Timestamp', 'Tgl_Sesi', 'Tahun', 'Bulan',
      'Role', 'Petugas', 'Target', 'Nama', 'Kehadiran',
      'Pelanggaran/Keterangan', 'Poin', 'NFC Code', 'QR Code', 'Metode', 'Waktu_Scan'
    ],
    extra: ['NFC Code', 'QR Code', 'Metode', 'Waktu_Scan']
  },
  Log_Absensi_Pengajar: {
    headers: [
      'ID_Sesi', 'Timestamp', 'Tgl_Sesi', 'Tahun', 'Bulan',
      'Role', 'Petugas', 'Target', 'Nama', 'Kehadiran',
      'Pelanggaran/Keterangan', 'Poin', 'NFC Code', 'QR Code', 'Metode', 'Waktu_Scan'
    ],
    extra: ['NFC Code', 'QR Code', 'Metode', 'Waktu_Scan']
  },
  Keuangan: {
    headers: ['ID', 'Tanggal', 'Keterangan', 'Jenis', 'Jumlah'],
    extra: []
  },
  Dana_Operasional: {
    headers: ['ID', 'Tanggal', 'Keterangan', 'Jenis', 'Jumlah'],
    extra: []
  },
  Pengumuman: {
    headers: ['ID', 'Tanggal', 'Isi', 'Penulis'],
    extra: []
  },
  Kotak_Saran: {
    headers: ['ID', 'Tanggal', 'Peran', 'Pengirim', 'Isi Saran'],
    extra: []
  },
  Surat: {
    headers: ['ID', 'Kategori', 'SubKategori', 'Nomor', 'Perihal', 'Tanggal', 'Pihak Tujuan', 'Drive_URL', 'Drive_File_ID'],
    extra: ['Drive_URL', 'Drive_File_ID']
  },
  Galeri: {
    headers: ['ID', 'Penulis', 'Jabatan', 'Tanggal', 'Tag', 'Caption', 'ImageURL', 'Likes', 'LikedBy', 'Drive_URL', 'Drive_File_ID'],
    extra: ['Likes', 'LikedBy', 'Drive_URL', 'Drive_File_ID']
  },
  IzinDigital: {
    headers: [
      'ID', 'NamaSantri', 'KamarKelas', 'Jenis', 'Mulai', 'Selesai',
      'Alasan', 'Pengaju', 'PeranPengaju', 'Status', 'DiprosesOleh', 'CatatanAdmin', 'CreatedAt'
    ],
    extra: ['CatatanAdmin', 'CreatedAt']
  },
  TindakanSantri: {
    headers: ['ID', 'Tanggal', 'NamaSantri', 'KamarKelas', 'Tindakan', 'Catatan', 'Petugas', 'PeranPetugas'],
    extra: []
  },
  SyncLog: {
    headers: ['ClientOpId', 'Action', 'Status', 'SyncedAt'],
    extra: []
  }
};

const HEADER_ALIASES_ = {
  'nfc code': ['nfc code', 'nfc_code', 'nfc', 'kode nfc', 'uid nfc', 'id nfc'],
  'qr code': ['qr code', 'qr_code', 'qr', 'kode qr', 'id qr'],
  'pin': ['pin', 'pin login', 'password', 'sandi', 'kode pin'],
  'metode': ['metode', 'metode_absen', 'metode absen', 'method'],
  'waktu_scan': ['waktu_scan', 'waktu scan', 'jam_scan', 'jam scan'],
  'drive_url': ['drive_url', 'drive url', 'link_drive', 'link drive'],
  'drive_file_id': ['drive_file_id', 'drive file id', 'file_id']
};

let SCRIPT_LOCK_DEPTH_ = 0;

// =========================================================================
// 0. ENTRY POINT HTTP (doGet & doPost) + OFFLINE-FIRST BATCH SYNC
// =========================================================================

function doGet(e) {
  try {
    if (e && e.parameter && e.parameter.action === 'ping') {
      return createJsonOutput_({
        ok: true,
        status: 'online',
        version: 'v22-unified-autoschema',
        serverTime: new Date().toISOString()
      });
    }

    ensureAllSheetsAndColumns_(false);

    if (e && e.parameter && e.parameter.payload) {
      const req = JSON.parse(e.parameter.payload);
      const fnName = String(req.fn || req.action || '').trim();
      const args = Array.isArray(req.args)
        ? req.args
        : (typeof req.payload !== 'undefined' ? [req.payload] : []);
      const result = routeApiRequest_(fnName, args, req.clientOpId || '');
      const cb = e.parameter.callback;
      if (cb) {
        return ContentService
          .createTextOutput(cb + '(' + JSON.stringify(result) + ');')
          .setMimeType(ContentService.MimeType.JAVASCRIPT);
      }
      return createJsonOutput_(result);
    }

    // Fallback Web App HTML jika dibuka langsung dari browser
    try {
      return HtmlService.createHtmlOutputFromFile('Index')
        .setTitle("Departemen Pendidikan - YPM Al-Rifa'ie 2")
        .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    } catch (htmlErr) {
      return createJsonOutput_({
        ok: true,
        service: "Backend Departemen Pendidikan - YPM Al-Rifa'ie 2",
        status: 'online',
        serverTime: new Date().toISOString()
      });
    }
  } catch (err) {
    const errPayload = {
      success: false,
      error: err && err.message ? err.message : String(err),
      message: err && err.message ? err.message : String(err)
    };
    if (e && e.parameter && e.parameter.callback) {
      return ContentService
        .createTextOutput(e.parameter.callback + '(' + JSON.stringify(errPayload) + ');')
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return createJsonOutput_(errPayload);
  }
}

function doPost(e) {
  try {
    const rawBody = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
    const body = JSON.parse(rawBody);
    const fnName = String(body.fn || body.action || '').trim();
    const clientOpId = String(body.clientOpId || '').trim();

    ensureAllSheetsAndColumns_(false);

    if (fnName === 'syncOfflineBatch') {
      const batchItems = Array.isArray(body.args) && Array.isArray(body.args[0])
        ? body.args[0]
        : (Array.isArray(body.payload) ? body.payload : []);
      return createJsonOutput_(syncOfflineBatch(batchItems));
    }

    // Normalisasi argumen agar kompatibel dengan format baru (`args: [...]`) & format lama
    let args = [];
    if (Array.isArray(body.args)) {
      args = body.args;
    } else if (fnName === 'verifyLogin') {
      args = [body.role, body.name, body.pin];
    } else if (fnName === 'submitAbsensi') {
      args = [body.payload && typeof body.payload === 'object' ? body.payload : body];
    } else if (fnName === 'saveFinancialData') {
      args = [body.item || body.payload, body.category || 'simpanan'];
    } else if (fnName === 'saveSuratData') {
      args = [body.item || body.payload];
    } else if (typeof body.payload !== 'undefined') {
      args = [body.payload];
    }

    const result = routeApiRequest_(fnName, args, clientOpId);
    return createJsonOutput_(result);
  } catch (err) {
    return createJsonOutput_({
      success: false,
      error: err && err.message ? err.message : String(err),
      message: err && err.message ? err.message : String(err)
    });
  }
}

function createJsonOutput_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function tryAcquireLock_(lock, waitMs) {
  try {
    if (lock.tryLock(waitMs || 12000)) return true;
  } catch (e) {}
  try {
    Utilities.sleep(350);
    return lock.tryLock(5000);
  } catch (e2) {
    return false;
  }
}

function withScriptLock_(waitMs, callbackFn) {
  if (SCRIPT_LOCK_DEPTH_ > 0) {
    SCRIPT_LOCK_DEPTH_++;
    try {
      return callbackFn();
    } finally {
      SCRIPT_LOCK_DEPTH_--;
    }
  }
  const lock = LockService.getScriptLock();
  if (!tryAcquireLock_(lock, waitMs || 15000)) {
    return {
      success: false,
      busy: true,
      message: 'Server sedang sibuk, silakan coba beberapa detik lagi.'
    };
  }
  SCRIPT_LOCK_DEPTH_ = 1;
  try {
    return callbackFn();
  } finally {
    SCRIPT_LOCK_DEPTH_ = 0;
    try { lock.releaseLock(); } catch (e) {}
  }
}

/**
 * Memproses antrean data offline secara berurutan (FIFO) dengan LockService & SyncLog.
 */
function syncOfflineBatch(items) {
  const lockedRes = withScriptLock_(15000, function () {
    const list = Array.isArray(items) ? items : [];
    const results = [];
    let syncedCount = 0;
    let duplicateCount = 0;
    let failedCount = 0;

    for (let i = 0; i < list.length; i++) {
      const item = list[i] || {};
      const clientOpId = String(item.clientOpId || '').trim();
      const fnName = String(item.fn || item.action || '').trim();
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
        const res = dispatchApiCall_(fnName, args);
        const rejected = res && typeof res === 'object' && res.success === false;
        if (rejected) {
          failedCount++;
          results.push({
            clientOpId: clientOpId,
            ok: false,
            error: res.message || res.error || 'Operasi ditolak oleh server.'
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
  });

  if (lockedRes && lockedRes.busy && typeof lockedRes.batchHandled === 'undefined') {
    lockedRes.batchHandled = false;
  }
  return lockedRes;
}

function routeApiRequest_(fnName, args, clientOpId) {
  if (fnName === 'ping') {
    return { ok: true, status: 'online', version: 'v22-unified-autoschema', serverTime: new Date().toISOString() };
  }

  if (!clientOpId) {
    return dispatchApiCall_(fnName, args);
  }

  return withScriptLock_(15000, function () {
    if (isOpAlreadySynced_(clientOpId)) {
      return { success: true, duplicate: true, message: 'Data sudah tersinkron sebelumnya.' };
    }
    const result = dispatchApiCall_(fnName, args);
    const rejected = result && typeof result === 'object' && result.success === false;
    if (!rejected) {
      recordSyncedOp_(clientOpId, fnName, 'OK');
    }
    return result;
  });
}

function dispatchApiCall_(fnName, args) {
  const safeArgs = Array.isArray(args) ? args : [];
  const allowedFns = {
    // Core, Setup & Auth
    getFastLoginData: getFastLoginData,
    getInitialBundle: getInitialBundle,
    getLoginData: getLoginData,
    getAppDataForRole: getAppDataForRole,
    getAppSettings: getAppSettings,
    verifyLogin: verifyLogin,
    updateAdminCredentials: updateAdminCredentials,
    updateAppSettings: updateAppSettings,
    setupSemuaSheetDanKolom: setupSemuaSheetDanKolom,
    testAuthorizationAndSetup: testAuthorizationAndSetup,
    // Absensi, Rekap & Tunggakan
    submitAbsensi: submitAbsensi,
    checkExistingAbsensi: checkExistingAbsensi,
    getRekapData: getRekapData,
    getTodayAttendanceSnapshot: getTodayAttendanceSnapshot,
    getMissingAttendance: getMissingAttendance,
    // Keuangan
    getFinancialData: getFinancialData,
    saveFinancialData: saveFinancialData,
    deleteFinancialData: deleteFinancialData,
    // User & Wali Santri
    getUsersData: getUsersData,
    saveUserData: saveUserData,
    deleteUserData: deleteUserData,
    getWaliSantriUsers: getWaliSantriUsers,
    saveWaliSantriUser: saveWaliSantriUser,
    deleteWaliSantriUser: deleteWaliSantriUser,
    verifyWaliSantriLogin: verifyWaliSantriLogin,
    // Pengumuman, Galeri, Saran, Surat
    getPengumuman: getPengumuman,
    savePengumuman: savePengumuman,
    deletePengumuman: deletePengumuman,
    getGaleriData: getGaleriData,
    saveGaleriData: saveGaleriData,
    deleteGaleriData: deleteGaleriData,
    toggleGaleriLike: toggleGaleriLike,
    getSaran: getSaran,
    saveSaran: saveSaran,
    deleteSaran: deleteSaran,
    getSurat: getSurat,
    saveSuratData: saveSuratData,
    deleteSurat: deleteSurat,
    // Master Database (NFC & QR)
    getDbData: getDbData,
    saveDbData: saveDbData,
    deleteDbData: deleteDbData,
    // Izin Digital & Log Tindakan Santri
    getIzinDigital: getIzinDigital,
    saveIzinDigital: saveIzinDigital,
    updateIzinDigitalStatus: updateIzinDigitalStatus,
    deleteIzinDigital: deleteIzinDigital,
    getSantriTindakan: getSantriTindakan,
    saveSantriTindakan: saveSantriTindakan,
    deleteSantriTindakan: deleteSantriTindakan,
    // Google Drive Backup & Foto Profil
    uploadHdImage: uploadHdImage,
    getDriveBackupStatus: getDriveBackupStatus,
    saveDriveBackupConfig: saveDriveBackupConfig,
    backupSuratPdfToDrive: backupSuratPdfToDrive,
    getUserProfilePhoto: getUserProfilePhoto,
    saveUserProfilePhoto: saveUserProfilePhoto
  };

  const targetFn = allowedFns[fnName];
  if (!targetFn) {
    throw new Error('Fungsi tidak dikenali: ' + fnName);
  }
  return targetFn.apply(null, safeArgs);
}

// =========================================================================
// HELPER UMUM: NORMALISASI, HEADER DINAMIS, CACHE & SYNCLOG
// =========================================================================

function safeSheetCell_(val, maxLen) {
  const s = String(val == null ? '' : val).trim().slice(0, maxLen || 400);
  if (/^[=+\-@\t\r]/.test(s)) return "'" + s;
  return s;
}

function normKey_(val) {
  return String(val || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normGroupKey_(val) {
  return String(val || '')
    .trim()
    .toLowerCase()
    .replace(/^(kamar|kelas)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatRowDateWib_(val) {
  if (!val) return '';
  if (val instanceof Date && !isNaN(val.getTime())) {
    return Utilities.formatDate(val, TIMEZONE_WIB, 'yyyy-MM-dd');
  }
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
  // Format dd-MM-yyyy atau dd/MM/yyyy
  const m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
  if (m) {
    return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  }
  try {
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      return Utilities.formatDate(d, TIMEZONE_WIB, 'yyyy-MM-dd');
    }
  } catch (e) {}
  return s.substring(0, 10);
}

function findHeaderColMap_(headerRow) {
  const map = {};
  (headerRow || []).forEach(function (h, idx) {
    const clean = String(h || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (clean && typeof map[clean] === 'undefined') map[clean] = idx;
  });
  return map;
}

function findHeaderColIndex_(headerMap, canonicalName) {
  const key = String(canonicalName || '').trim().toLowerCase();
  if (typeof headerMap[key] === 'number') return headerMap[key];
  const aliases = HEADER_ALIASES_[key];
  if (Array.isArray(aliases)) {
    for (let i = 0; i < aliases.length; i++) {
      if (typeof headerMap[aliases[i]] === 'number') return headerMap[aliases[i]];
    }
  }
  return -1;
}

function styleHeaderRange_(range) {
  try {
    range.setFontWeight('bold').setBackground('#EEF2FF').setFontColor('#1E1B4B');
  } catch (e) {}
}

function ensureExtraHeaders_(sheet, headerNames) {
  if (!sheet || !Array.isArray(headerNames) || headerNames.length === 0) return {};
  const lastRow = sheet.getLastRow();
  const lastCol = Math.max(0, sheet.getLastColumn());
  let existing = [];
  if (lastRow > 0 && lastCol > 0) {
    existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) {
      return String(h || '').trim();
    });
  }
  const hMap = findHeaderColMap_(existing);
  const colMap = {};
  let nextCol = existing.length;
  // Pangkas trailing kolom kosong di header agar kolom baru rapi tepat setelah kolom terakhir terisi
  while (nextCol > 0 && !existing[nextCol - 1]) {
    nextCol--;
  }

  let addedAny = false;
  headerNames.forEach(function (name) {
    const foundIdx = findHeaderColIndex_(hMap, name);
    if (foundIdx !== -1) {
      colMap[name] = foundIdx + 1;
    } else {
      nextCol++;
      const cell = sheet.getRange(1, nextCol);
      cell.setValue(name);
      styleHeaderRange_(cell);
      hMap[String(name).trim().toLowerCase()] = nextCol - 1;
      colMap[name] = nextCol;
      addedAny = true;
    }
  });
  if (addedAny) {
    try {
      if (sheet.getFrozenRows() < 1) sheet.setFrozenRows(1);
    } catch (e) {}
  }
  return colMap;
}

let __verifiedSheetsThisExec_ = {};
let __schemaCacheReadyMemo_ = null;

function isSchemaCacheReady_() {
  if (__schemaCacheReadyMemo_ !== null) return __schemaCacheReadyMemo_;
  try {
    __schemaCacheReadyMemo_ = CacheService.getScriptCache().get(SCHEMA_READY_CACHE_KEY) === '1';
  } catch (e) {
    __schemaCacheReadyMemo_ = false;
  }
  return __schemaCacheReadyMemo_;
}

/**
 * Memastikan 1 sheet tertentu ada beserta seluruh header & kolom tambahannya (NFC Code, QR Code, dll.).
 * Fast-path: bila sheet sudah ada & skema sudah terverifikasi di CacheService (6 jam), langsung kembalikan sheet
 * tanpa mengulang RPC getLastRow/getRange header pada setiap request harian.
 */
function ensureSheetReady_(sheetName, ssOpt, forceHeaderCheck) {
  const ss = ssOpt || SpreadsheetApp.getActiveSpreadsheet();
  const schema = APP_SHEET_SCHEMAS_[sheetName];
  let sheet = ss.getSheetByName(sheetName);
  let createdSheet = false;

  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    createdSheet = true;
    __schemaCacheReadyMemo_ = false;
  }

  if (!createdSheet && !forceHeaderCheck && (__verifiedSheetsThisExec_[sheetName] || isSchemaCacheReady_())) {
    __verifiedSheetsThisExec_[sheetName] = true;
    return sheet;
  }

  if (schema && Array.isArray(schema.headers) && schema.headers.length > 0) {
    if (sheet.getLastRow() === 0) {
      if (sheetName === 'Settings') {
        sheet.getRange(1, 1, 7, 2).setValues([
          ['Key', 'Value'],
          ['appName', 'Departemen Pendidikan'],
          ['logoUrl', ''],
          ['bannerUrl', ''],
          ['suratTemplateId', ''],
          ['adminUsername', 'Amir Ganteng'],
          ['adminPin', '1312']
        ]);
        styleHeaderRange_(sheet.getRange(1, 1, 1, 2));
      } else {
        sheet.getRange(1, 1, 1, schema.headers.length).setValues([schema.headers]);
        styleHeaderRange_(sheet.getRange(1, 1, 1, schema.headers.length));
      }
      try { sheet.setFrozenRows(1); } catch (e) {}
    } else if (Array.isArray(schema.extra) && schema.extra.length > 0) {
      ensureExtraHeaders_(sheet, schema.extra);
    }
  } else if (createdSheet) {
    try { sheet.setFrozenRows(1); } catch (e) {}
  }

  __verifiedSheetsThisExec_[sheetName] = true;
  return sheet;
}

/**
 * Otomatis membuat semua sheet & kolom wajib yang belum ada di Spreadsheet.
 * Menggunakan CacheService (6 jam) agar hanya berjalan sekali dan tidak memperlambat request harian.
 */
function ensureAllSheetsAndColumns_(force) {
  const cache = CacheService.getScriptCache();
  if (!force) {
    try {
      if (cache.get(SCHEMA_READY_CACHE_KEY) === '1') {
        return { skipped: true };
      }
    } catch (e) {}
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const report = {
    createdSheets: [],
    updatedSheets: [],
    totalSheetsChecked: 0
  };

  Object.keys(APP_SHEET_SCHEMAS_).forEach(function (sheetName) {
    report.totalSheetsChecked++;
    const existed = Boolean(ss.getSheetByName(sheetName));
    const prevLastCol = existed ? ss.getSheetByName(sheetName).getLastColumn() : 0;
    const sheet = ensureSheetReady_(sheetName, ss, true);
    if (!existed) {
      report.createdSheets.push(sheetName);
    } else if (sheet.getLastColumn() > prevLastCol) {
      report.updatedSheets.push(sheetName);
    }
  });

  try {
    cache.put(SCHEMA_READY_CACHE_KEY, '1', 21600);
    __schemaCacheReadyMemo_ = true;
  } catch (e) {}

  return report;
}

function trackCacheKey_(scriptCache, listKey, cacheKey) {
  try {
    const rawKeys = scriptCache.get(listKey);
    let keyList = [];
    try { keyList = rawKeys ? JSON.parse(rawKeys) : []; } catch (e) { keyList = []; }
    if (!Array.isArray(keyList)) keyList = [];
    if (keyList.indexOf(cacheKey) === -1) {
      keyList.push(cacheKey);
      if (keyList.length > 40) keyList = keyList.slice(keyList.length - 40);
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

const CACHE_CHUNK_SIZE_ = 78000;
const CACHE_MAX_CHUNKS_ = 8;

function putChunkedCache_(baseKey, obj, ttlSec) {
  try {
    const cache = CacheService.getScriptCache();
    const str = JSON.stringify(obj);
    if (!str) return false;
    const ttl = ttlSec || 120;
    if (str.length <= CACHE_CHUNK_SIZE_) {
      cache.putAll({ [baseKey + '__meta']: '1', [baseKey + '__c0']: str }, ttl);
      return true;
    }
    const count = Math.ceil(str.length / CACHE_CHUNK_SIZE_);
    if (count > CACHE_MAX_CHUNKS_) return false;
    const entries = {};
    entries[baseKey + '__meta'] = String(count);
    for (let i = 0; i < count; i++) {
      entries[baseKey + '__c' + i] = str.substring(i * CACHE_CHUNK_SIZE_, (i + 1) * CACHE_CHUNK_SIZE_);
    }
    cache.putAll(entries, ttl);
    return true;
  } catch (e) {
    return false;
  }
}

function getChunkedCache_(baseKey) {
  try {
    const cache = CacheService.getScriptCache();
    const meta = cache.get(baseKey + '__meta');
    if (!meta) return null;
    const count = parseInt(meta, 10);
    if (!count || count < 1 || count > CACHE_MAX_CHUNKS_) return null;
    if (count === 1) {
      const s0 = cache.get(baseKey + '__c0');
      return s0 ? JSON.parse(s0) : null;
    }
    const keys = [];
    for (let i = 0; i < count; i++) keys.push(baseKey + '__c' + i);
    const map = cache.getAll(keys);
    let combined = '';
    for (let i = 0; i < count; i++) {
      const part = map[baseKey + '__c' + i];
      if (typeof part !== 'string') return null;
      combined += part;
    }
    return combined ? JSON.parse(combined) : null;
  } catch (e) {
    return null;
  }
}

function removeChunkedCache_(cache, baseKey) {
  try {
    const keys = [baseKey + '__meta'];
    for (let i = 0; i < CACHE_MAX_CHUNKS_; i++) keys.push(baseKey + '__c' + i);
    cache.removeAll(keys);
  } catch (e) {}
}

function invalidateCaches_(scope) {
  try {
    const cache = CacheService.getScriptCache();
    if (scope === 'absensi' || scope === 'all') {
      clearTrackedCacheKeys_(cache, 'MISSING_ATT_V2_KEYS');
      clearTrackedCacheKeys_(cache, 'TODAY_SNAP_KEYS');
      cache.removeAll([
        'REKAP_CACHE_wb',
        'REKAP_CACHE_takhassus',
        'REKAP_CACHE_musyrif',
        'REKAP_CACHE_pengajar'
      ]);
      ['wb', 'takhassus', 'musyrif', 'pengajar'].forEach(function (act) {
        removeChunkedCache_(cache, 'REKAP_CHUNK_' + act);
      });
    }
    if (scope === 'master' || scope === 'settings' || scope === 'pengumuman' || scope === 'galeri' || scope === 'all') {
      cache.remove('FAST_LOGIN_DATA');
      cache.remove('GALERI_CACHE_V1');
      removeChunkedCache_(cache, 'INITIAL_BUNDLE_V1');
      if (scope === 'master' || scope === 'all') {
        removeChunkedCache_(cache, 'CORE_DATA_V1');
        clearTrackedCacheKeys_(cache, 'MISSING_ATT_V2_KEYS');
      }
    }
  } catch (e) {}
}

function getOrCreateSyncLogSheet_() {
  return ensureSheetReady_(SYNC_LOG_SHEET_NAME);
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

// =========================================================================
// 1. INTEGRASI GOOGLE DRIVE (GALERI SANTRI, ARSIP SURAT PDF & PROFIL)
// =========================================================================

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
      Logger.log('Folder ID Drive tidak ditemukan, menggunakan folder default: ' + e);
    }
  }
  const folderName = cfg.rootFolderName || DEFAULT_DRIVE_ROOT_FOLDER;
  const folders = DriveApp.getFoldersByName(folderName);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(folderName);
}

function getOrCreateDriveSubfolder_(subName) {
  const root = getOrCreateDriveRootFolder_();
  if (!subName) return root;
  const subs = root.getFoldersByName(subName);
  return subs.hasNext() ? subs.next() : root.createFolder(subName);
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

function saveImageToDrive_(dataUrl, fileName, subFolderName) {
  if (!dataUrl || String(dataUrl).indexOf('data:image') !== 0) return String(dataUrl || '');
  try {
    const prefix = String(fileName || 'media').replace(/\.[a-z0-9]+$/i, '');
    const saved = saveHdImageToDrive_(dataUrl, prefix, subFolderName || 'Media_Aplikasi');
    return saved.url;
  } catch (err) {
    Logger.log('Fallback saveImageToDrive_: ' + err);
    return String(dataUrl);
  }
}

function uploadHdImage(payload) {
  try {
    const d = payload && typeof payload === 'object' ? payload : {};
    const dataUrl = d.dataUrl ? String(d.dataUrl) : '';
    const prefix = d.prefix ? String(d.prefix).replace(/[^a-zA-Z0-9_-]/g, '') : 'media';
    const subFolder = d.subFolder
      ? String(d.subFolder).replace(/[^a-zA-Z0-9_-]/g, '')
      : (prefix.indexOf('galeri') !== -1
          ? 'Galeri_Santri'
          : (prefix.indexOf('profil') !== -1 ? 'Profil_Pengguna' : 'Media_Aplikasi'));
    if (!dataUrl || dataUrl.indexOf('data:image/') !== 0) {
      return { success: false, error: 'Data gambar tidak valid.' };
    }
    const saved = saveHdImageToDrive_(dataUrl, prefix, subFolder);
    return {
      success: true,
      url: saved.url,
      viewUrl: saved.viewUrl,
      fileId: saved.fileId,
      folderName: subFolder
    };
  } catch (err) {
    return { success: false, error: err && err.message ? err.message : String(err) };
  }
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
    rootFolderName: (typeof d.rootFolderName === 'string' && d.rootFolderName.trim())
      ? d.rootFolderName.trim()
      : prev.rootFolderName
  };
  PropertiesService.getScriptProperties().setProperty(DRIVE_CONFIG_PROP_KEY, JSON.stringify(next));
  invalidateCaches_('settings');
  return getDriveBackupStatus();
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

function saveSuratDriveMapEntry_(key, meta, idKey) {
  try {
    const props = PropertiesService.getScriptProperties();
    const map = readSuratDriveMap_();
    if (key) map[key] = meta;
    if (idKey) map['id_' + String(idKey)] = meta;
    const keys = Object.keys(map);
    if (keys.length > 160) {
      keys.slice(0, keys.length - 160).forEach(function (oldK) { delete map[oldK]; });
    }
    props.setProperty(SURAT_DRIVE_MAP_PROP_KEY, JSON.stringify(map));
  } catch (e) {
    Logger.log('Info simpan surat drive map: ' + e);
  }
}

function backupSuratHtmlToDriveInternal_(suratPayload, htmlSnapshot, savedId) {
  const nomor = String(suratPayload.nomor || ('Surat_' + Date.now())).trim();
  const perihal = String(suratPayload.perihal || 'Dokumen_Surat').trim();
  const kategori = String(suratPayload.kategori || '').trim();
  const isSp = kategori.toLowerCase().indexOf('sp') !== -1 || perihal.toLowerCase().indexOf('surat pernyataan') !== -1;
  const safeBase = ((isSp ? 'Surat_SP_' : 'Surat_') + nomor + '_' + (suratPayload.tujuan || perihal))
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .slice(0, 85);

  const fullHtml = htmlSnapshot && htmlSnapshot.length > 40
    ? ('<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:Times New Roman,serif;margin:0;padding:12mm;color:#111;background:#fff;}</style></head><body>' + htmlSnapshot + '</body></html>')
    : ('<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:serif;padding:24px;"><h2>' + perihal + '</h2><p><b>Nomor:</b> ' + nomor + '</p><p><b>Kategori:</b> ' + (kategori || '-') + '</p><p><b>Tujuan:</b> ' + String(suratPayload.tujuan || '-') + '</p></body></html>');

  const folder = getOrCreateDriveSubfolder_(isSp ? 'Arsip_Surat_SP' : 'Arsip_Surat');
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
  saveSuratDriveMapEntry_(normalizeSuratDriveKey_(nomor, perihal), meta, savedId || suratPayload.id);
  return meta;
}

function backupSuratPdfToDrive(payload) {
  try {
    const cfg = getDriveBackupConfig_();
    if (!cfg.enabled || !cfg.backupSurat) {
      return { success: false, skipped: true, message: 'Backup otomatis surat ke Drive sedang dinonaktifkan.' };
    }
    const d = payload && typeof payload === 'object' ? payload : {};
    const meta = backupSuratHtmlToDriveInternal_(d, String(d.html || d.driveHtmlSnapshot || ''), d.id || '');
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

// =========================================================================
// 2. FOTO PROFIL PENGGUNA (TERSIMPAN DI DRIVE + SINKRON LINTAS PERANGKAT)
// =========================================================================

function readProfilePhotoMap_() {
  const map = {};
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(PROFILE_PHOTO_PROP_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object') {
      Object.keys(parsed).forEach(function (k) {
        if (parsed[k]) map[String(k).trim().toLowerCase()] = String(parsed[k]);
      });
    }
  } catch (e) {}

  try {
    const sh = ensureSheetReady_(PROFILE_PHOTO_SHEET_NAME);
    if (sh.getLastRow() > 1) {
      const rows = sh.getRange(2, 1, sh.getLastRow() - 1, Math.max(4, sh.getLastColumn())).getValues();
      rows.forEach(function (r) {
        const k = String(r[0] || '').trim().toLowerCase();
        const url = String(r[3] || '').trim();
        if (k && url) map[k] = url;
      });
    }
  } catch (e) {}
  return map;
}

function getUserProfilePhoto(userKey) {
  try {
    const key = String(userKey || '').trim().toLowerCase();
    if (!key) return { success: true, photoUrl: '' };
    const map = readProfilePhotoMap_();
    return { success: true, photoUrl: map[key] ? String(map[key]) : '' };
  } catch (e) {
    return { success: false, photoUrl: '' };
  }
}

function saveUserProfilePhoto(payload) {
  return withScriptLock_(15000, function () {
    try {
      const d = payload && typeof payload === 'object' ? payload : {};
      const key = String(d.userKey || '').trim().toLowerCase();
      if (!key) return { success: false, message: 'Kunci pengguna tidak valid.' };

      const sh = ensureSheetReady_(PROFILE_PHOTO_SHEET_NAME);
      const raw = PropertiesService.getScriptProperties().getProperty(PROFILE_PHOTO_PROP_KEY);
      const map = raw ? JSON.parse(raw) : {};
      const nowIso = new Date().toISOString();

      let finalUrl = '';
      if (d.remove === true || !d.dataUrl) {
        delete map[key];
      } else {
        finalUrl = String(d.dataUrl);
        if (finalUrl.indexOf('data:image/') === 0) {
          try {
            const saved = saveHdImageToDrive_(finalUrl, 'profil_' + key.replace(/[^a-z0-9]/g, '_').slice(0, 24), 'Profil_Pengguna');
            finalUrl = saved.url;
          } catch (drvErr) {
            Logger.log('Fallback simpan foto profil: ' + drvErr);
          }
        }
        map[key] = finalUrl;
      }

      try {
        PropertiesService.getScriptProperties().setProperty(PROFILE_PHOTO_PROP_KEY, JSON.stringify(map));
      } catch (propErr) {}

      // Sinkronkan juga ke Sheet Foto_Profil agar mudah dipantau/backup di Spreadsheet
      const lastRow = sh.getLastRow();
      let foundRow = -1;
      if (lastRow > 1) {
        const keys = sh.getRange(2, 1, lastRow - 1, 1).getValues();
        for (let i = 0; i < keys.length; i++) {
          if (String(keys[i][0] || '').trim().toLowerCase() === key) {
            foundRow = i + 2;
            break;
          }
        }
      }

      if (!finalUrl) {
        if (foundRow >= 2) sh.deleteRow(foundRow);
      } else {
        const rowVals = [key, safeSheetCell_(d.name || '', 120), safeSheetCell_(d.role || '', 40), finalUrl, nowIso];
        if (foundRow >= 2) {
          sh.getRange(foundRow, 1, 1, 5).setValues([rowVals]);
        } else {
          sh.appendRow(rowVals);
        }
      }
      SpreadsheetApp.flush();
      return { success: true, photoUrl: finalUrl };
    } catch (err) {
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  });
}

// =========================================================================
// 3. SETTINGS, BATAS WAKTU, HAK AKSES PERAN & BUNDLE AWAL
// =========================================================================

function getAppSettings() {
  try {
    const sheet = ensureSheetReady_('Settings');
    const data = sheet.getDataRange().getValues();
    const settings = {};
    for (let i = 1; i < data.length; i++) {
      if (data[i][0]) settings[String(data[i][0]).trim()] = String(data[i][1] || '').trim();
    }
    if (!settings.adminUsername) settings.adminUsername = 'Amir Ganteng';
    if (!settings.adminPin) settings.adminPin = '1312';
    return settings;
  } catch (err) {
    return {
      appName: 'Departemen Pendidikan',
      logoUrl: '',
      bannerUrl: '',
      adminUsername: 'Amir Ganteng',
      adminPin: '1312'
    };
  }
}

function buildPublicSettings_(rawSettings) {
  const s = rawSettings || getAppSettings();
  const out = {
    appName: s.appName || 'Departemen Pendidikan',
    logoUrl: s.logoUrl || '',
    bannerUrl: s.bannerUrl || '',
    adminUsername: s.adminUsername || 'Amir Ganteng'
  };
  try {
    const props = PropertiesService.getScriptProperties();
    const rawDl = props.getProperty('ALRIFAIE_ATTENDANCE_DEADLINES');
    const rawRp = props.getProperty('ALRIFAIE_ROLE_PERMISSIONS');
    const rawSp = props.getProperty('ALRIFAIE_STAFF_PERM_OVERRIDES');
    if (rawDl) out.attendanceDeadlines = JSON.parse(rawDl);
    if (rawRp) out.rolePermissions = JSON.parse(rawRp);
    if (rawSp) out.staffPermissionOverrides = JSON.parse(rawSp);
    out.driveConfig = getDriveBackupConfig_();
  } catch (e) {}
  return out;
}

function updateAppSettings(newSettings) {
  const sheet = ensureSheetReady_('Settings');
  const current = getAppSettings();

  const payload = Object.assign({}, newSettings || {});

  // Simpan pengaturan lanjutan ke ScriptProperties agar rapi & tidak memenuhi Sheet Settings
  try {
    const props = PropertiesService.getScriptProperties();
    if (payload.attendanceDeadlines && typeof payload.attendanceDeadlines === 'object') {
      props.setProperty('ALRIFAIE_ATTENDANCE_DEADLINES', JSON.stringify(payload.attendanceDeadlines));
    }
    if (payload.rolePermissions && typeof payload.rolePermissions === 'object') {
      props.setProperty('ALRIFAIE_ROLE_PERMISSIONS', JSON.stringify(payload.rolePermissions));
    }
    if (payload.staffPermissionOverrides && typeof payload.staffPermissionOverrides === 'object') {
      props.setProperty('ALRIFAIE_STAFF_PERM_OVERRIDES', JSON.stringify(payload.staffPermissionOverrides));
    }
    if (payload.driveConfig && typeof payload.driveConfig === 'object') {
      saveDriveBackupConfig(payload.driveConfig);
    }
  } catch (propErr) {
    Logger.log('Info simpan extra settings: ' + propErr);
  }

  delete payload.attendanceDeadlines;
  delete payload.rolePermissions;
  delete payload.staffPermissionOverrides;
  delete payload.driveConfig;

  if (payload.logoUrl && String(payload.logoUrl).indexOf('data:image') === 0) {
    payload.logoUrl = saveImageToDrive_(payload.logoUrl, 'logo_app_' + Date.now() + '.jpg', 'Media_Aplikasi');
  }
  if (payload.bannerUrl && String(payload.bannerUrl).indexOf('data:image') === 0) {
    payload.bannerUrl = saveImageToDrive_(payload.bannerUrl, 'banner_app_' + Date.now() + '.jpg', 'Media_Aplikasi');
  }

  const merged = Object.assign({}, current, payload);
  const rows = [['Key', 'Value']];
  for (let key in merged) {
    if (Object.prototype.hasOwnProperty.call(merged, key)) {
      rows.push([key, String(merged[key] || '')]);
    }
  }

  sheet.clearContents();
  sheet.getRange(1, 1, rows.length, 2).setValues(rows);
  SpreadsheetApp.flush();
  invalidateCaches_('settings');

  return {
    success: true,
    settings: buildPublicSettings_(merged)
  };
}

function updateAdminCredentials(newUsername, newPin) {
  if (!newUsername || !newPin) {
    return { success: false, message: 'Username dan Password tidak boleh kosong!' };
  }
  return updateAppSettings({
    adminUsername: String(newUsername).trim(),
    adminPin: String(newPin).trim()
  });
}

function getInitialBundle() {
  const cached = getChunkedCache_('INITIAL_BUNDLE_V1');
  if (cached) return cached;

  const settings = getAppSettings();
  const bundle = {
    settings: buildPublicSettings_(settings),
    loginData: getLoginData(),
    coreData: getAppDataForRole(),
    pengumuman: getPengumuman(),
    galeri: getGaleriData()
  };
  putChunkedCache_('INITIAL_BUNDLE_V1', bundle, 120);
  return bundle;
}

function getFastLoginData() {
  const cache = CacheService.getScriptCache();
  try {
    const cached = cache.get('FAST_LOGIN_DATA');
    if (cached) return JSON.parse(cached);
  } catch (e) {}

  const settings = getAppSettings();
  const res = {
    settings: buildPublicSettings_(settings),
    loginData: getLoginData(),
    pengumuman: getPengumuman()
  };

  try {
    const ser = JSON.stringify(res);
    if (ser && ser.length < 95000) cache.put('FAST_LOGIN_DATA', ser, 180);
  } catch (e) {}
  return res;
}

// =========================================================================
// 4. LOGIN, MANAJEMEN USER & AKUN WALI SANTRI
// =========================================================================

function getUsersSheet() {
  return ensureSheetReady_('Data_Users');
}

function getUsersData() {
  const sheet = getUsersSheet();
  const data = sheet.getDataRange().getValues();
  const list = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i][1]) {
      list.push({
        id: String(data[i][0]),
        username: String(data[i][1]).trim(),
        pin: String(data[i][2] || '').trim(),
        jabatan: String(data[i][3] || 'Pengurus').trim(),
        akses: String(data[i][4] || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean)
      });
    }
  }
  return list;
}

function saveUserData(user) {
  const sheet = getUsersSheet();
  const data = sheet.getDataRange().getValues();
  const u = user && typeof user === 'object' ? user : {};
  const aksesStr = Array.isArray(u.akses) ? u.akses.join(',') : String(u.akses || '');
  if (u.id) {
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(u.id)) {
        sheet.getRange(i + 1, 2, 1, 4).setValues([[
          String(u.username || '').trim(),
          String(u.pin || '').trim(),
          String(u.jabatan || 'Pengurus').trim(),
          aksesStr
        ]]);
        SpreadsheetApp.flush();
        invalidateCaches_('master');
        return { success: true };
      }
    }
  }
  const newId = 'USR_' + new Date().getTime();
  sheet.appendRow([
    newId,
    String(u.username || '').trim(),
    String(u.pin || '').trim(),
    String(u.jabatan || 'Pengurus').trim() || 'Pengurus',
    aksesStr
  ]);
  SpreadsheetApp.flush();
  invalidateCaches_('master');
  return { success: true, id: newId };
}

function deleteUserData(id) {
  const sheet = getUsersSheet();
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      sheet.deleteRow(i + 1);
      SpreadsheetApp.flush();
      invalidateCaches_('master');
      return { success: true };
    }
  }
  return { success: false };
}

function getLoginData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sMusyrif = ensureSheetReady_('Data_Musyrif', ss);
  const musyrifs = [];
  if (sMusyrif && sMusyrif.getLastRow() > 1) {
    const data = sMusyrif.getDataRange().getValues();
    const hMap = findHeaderColMap_(data[0]);
    const nfcCol = findHeaderColIndex_(hMap, 'nfc code');
    const qrCol = findHeaderColIndex_(hMap, 'qr code');
    for (let i = 1; i < data.length; i++) {
      if (data[i][0]) {
        musyrifs.push({
          nama: String(data[i][0]).trim(),
          kamar: String(data[i][1] || '').trim(),
          nfcCode: nfcCol >= 0 ? String(data[i][nfcCol] || '').trim() : '',
          qrCode: qrCol >= 0 ? String(data[i][qrCol] || '').trim() : ''
        });
      }
    }
  }
  const sPengajar = ensureSheetReady_('Data_Pengajar_Takhassus', ss);
  const pengajars = [];
  if (sPengajar && sPengajar.getLastRow() > 1) {
    const data = sPengajar.getDataRange().getValues();
    const hMap = findHeaderColMap_(data[0]);
    const nfcCol = findHeaderColIndex_(hMap, 'nfc code');
    const qrCol = findHeaderColIndex_(hMap, 'qr code');
    for (let i = 1; i < data.length; i++) {
      if (data[i][1] || data[i][0]) {
        pengajars.push({
          nama: String(data[i][1] || data[i][0]).trim(),
          kelas: String(data[i][2] || '').trim(),
          qismu: String(data[i][3] || '').trim(),
          nfcCode: nfcCol >= 0 ? String(data[i][nfcCol] || '').trim() : '',
          qrCode: qrCol >= 0 ? String(data[i][qrCol] || '').trim() : ''
        });
      }
    }
  }
  const customUsers = getUsersData().map(function (u) {
    return { username: u.username, jabatan: u.jabatan };
  });
  return { musyrifs: musyrifs, pengajars: pengajars, customUsers: customUsers };
}

function getEffectiveStaffPermissions_(role, personName, fallbackPerms) {
  let perms = Array.isArray(fallbackPerms) ? fallbackPerms.slice() : [];
  try {
    const props = PropertiesService.getScriptProperties();
    const rawRp = props.getProperty('ALRIFAIE_ROLE_PERMISSIONS');
    if (rawRp) {
      const rp = JSON.parse(rawRp);
      if (rp && Array.isArray(rp[role])) perms = rp[role].slice();
    }
    const rawSp = props.getProperty('ALRIFAIE_STAFF_PERM_OVERRIDES');
    if (rawSp) {
      const sp = JSON.parse(rawSp);
      const staffKey = String(role || '').toLowerCase() + '::' + String(personName || '').trim().toLowerCase();
      if (sp && Array.isArray(sp[staffKey])) {
        perms = sp[staffKey].slice();
      }
    }
  } catch (e) {}
  return perms;
}

function verifyLogin(role, name, pin) {
  try {
    const cleanRole = String(role || '').trim().toLowerCase();
    const cleanName = String(name || '').trim();
    const cleanPin = String(pin || '').trim();

    if (cleanRole === 'walisantri') {
      return verifyWaliSantriLogin(cleanName, cleanPin);
    }

    if (cleanRole === 'admin') {
      const settings = getAppSettings();
      if (cleanName === settings.adminUsername && cleanPin === settings.adminPin) {
        return {
          success: true,
          role: 'admin',
          username: settings.adminUsername,
          name: settings.adminUsername,
          permissions: ['ALL']
        };
      }
      return { success: false, message: 'Username atau Password Admin salah!' };
    }

    if (cleanRole === 'user') {
      const users = getUsersData();
      const found = users.find(function (u) {
        return u.username === cleanName && u.pin === cleanPin;
      });
      if (found) {
        return {
          success: true,
          role: 'user',
          username: found.username,
          name: found.username,
          jabatan: found.jabatan,
          permissions: Array.isArray(found.akses) ? found.akses : []
        };
      }
      return { success: false, message: 'Username atau PIN User salah!' };
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (cleanRole === 'musyrif') {
      const sMusyrif = ensureSheetReady_('Data_Musyrif', ss);
      if (sMusyrif && sMusyrif.getLastRow() > 1) {
        const data = sMusyrif.getDataRange().getValues();
        const hMap = findHeaderColMap_(data[0]);
        const pinCol = findHeaderColIndex_(hMap, 'pin');
        for (let i = 1; i < data.length; i++) {
          const pinCell = pinCol >= 0 ? data[i][pinCol] : data[i][2];
          if (String(data[i][0]).trim() === cleanName && String(pinCell || '123456').trim() === cleanPin) {
            return {
              success: true,
              role: 'musyrif',
              username: cleanName,
              name: cleanName,
              kamar: String(data[i][1] || '').trim(),
              permissions: getEffectiveStaffPermissions_('musyrif', cleanName, ['wb'])
            };
          }
        }
      }
    }

    if (cleanRole === 'pengajar') {
      const sPengajar = ensureSheetReady_('Data_Pengajar_Takhassus', ss);
      if (sPengajar && sPengajar.getLastRow() > 1) {
        const data = sPengajar.getDataRange().getValues();
        const hMap = findHeaderColMap_(data[0]);
        const pinCol = findHeaderColIndex_(hMap, 'pin');
        for (let i = 1; i < data.length; i++) {
          const namaRow = String(data[i][1] || data[i][0]).trim();
          const pinCell = pinCol >= 0 ? data[i][pinCol] : (data[i][4] || data[i][3]);
          const pinRow = String(pinCell || '123456').trim();
          if (namaRow === cleanName && pinRow === cleanPin) {
            return {
              success: true,
              role: 'pengajar',
              username: namaRow,
              name: namaRow,
              kelas: String(data[i][2] || '').trim(),
              qismu: String(data[i][3] || '').trim(),
              permissions: getEffectiveStaffPermissions_('pengajar', namaRow, ['takhassus'])
            };
          }
        }
      }
    }

    return { success: false, message: 'Nama atau PIN salah!' };
  } catch (err) {
    return { success: false, message: 'Gagal memverifikasi login: ' + err.message };
  }
}

// --- Akun & Autentikasi Wali Santri (SHA-256 bersalt) ---

function readWaliSantriStore_() {
  try {
    const sh = ensureSheetReady_(WALI_SANTRI_SHEET_NAME);
    if (sh.getLastRow() > 1) {
      const rows = sh.getRange(2, 1, sh.getLastRow() - 1, Math.max(10, sh.getLastColumn())).getValues();
      const fromSheet = [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (!r[0] && !r[1]) continue;
        fromSheet.push({
          id: String(r[0] || ('ws_' + (i + 1))),
          username: String(r[1] || '').trim(),
          namaWali: String(r[2] || '').trim(),
          namaSantri: String(r[3] || '').trim(),
          akses: String(r[4] || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
          sharedSingle: String(r[5]).toLowerCase() === 'true' || r[5] === true || String(r[0]) === 'wali_shared_main',
          salt: String(r[6] || '').trim(),
          passwordHash: String(r[7] || '').trim(),
          createdAt: String(r[8] || ''),
          updatedAt: String(r[9] || '')
        });
      }
      if (fromSheet.length > 0) return fromSheet;
    }
  } catch (sheetErr) {
    Logger.log('Info baca Sheet Akun_Wali_Santri: ' + sheetErr);
  }

  // Migrasi otomatis dari PropertiesService jika sebelumnya tersimpan di sana
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(WALI_SANTRI_PROP_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed) && parsed.length > 0) {
      try { writeWaliSantriSheetOnly_(parsed); } catch (mErr) {}
      return parsed;
    }
  } catch (e) {}
  return [];
}

function writeWaliSantriSheetOnly_(list) {
  const sh = ensureSheetReady_(WALI_SANTRI_SHEET_NAME);
  const headers = APP_SHEET_SCHEMAS_[WALI_SANTRI_SHEET_NAME].headers;
  const rows = [headers];
  (list || []).forEach(function (u) {
    rows.push([
      String(u.id || ''),
      String(u.username || '').trim(),
      String(u.namaWali || '').trim(),
      String(u.namaSantri || '').trim(),
      Array.isArray(u.akses) ? u.akses.join(',') : String(u.akses || ''),
      Boolean(u.sharedSingle) ? 'TRUE' : 'FALSE',
      String(u.salt || ''),
      String(u.passwordHash || ''),
      String(u.createdAt || ''),
      String(u.updatedAt || new Date().toISOString())
    ]);
  });
  sh.clearContents();
  sh.getRange(1, 1, rows.length, headers.length).setValues(rows);
  styleHeaderRange_(sh.getRange(1, 1, 1, headers.length));
  SpreadsheetApp.flush();
}

function writeWaliSantriStore_(list) {
  const safeList = Array.isArray(list) ? list : [];
  try {
    PropertiesService.getScriptProperties().setProperty(WALI_SANTRI_PROP_KEY, JSON.stringify(safeList));
  } catch (e) {}
  writeWaliSantriSheetOnly_(safeList);
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
      sharedSingle: Boolean(u.sharedSingle),
      createdAt: u.createdAt || ''
    };
  });
}

function saveWaliSantriUser(payload) {
  return withScriptLock_(15000, function () {
    const data = payload && typeof payload === 'object' ? payload : {};
    const id = String(data.id || '').trim();
    const username = String(data.username || '').trim();
    const password = String(data.password || '');
    const namaWali = String(data.namaWali || '').trim();
    const namaSantri = String(data.namaSantri || '').trim();
    const sharedSingle = Boolean(data.sharedSingle) || id === 'wali_shared_main';
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
      const sharedId = 'wali_shared_main';
      writeWaliSantriStore_([{
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
      }]);
      return { success: true, id: sharedId };
    }

    const dupIdx = list.findIndex(function (x) {
      return String(x.username || '').toLowerCase() === username.toLowerCase() && String(x.id) !== id;
    });
    if (dupIdx !== -1) {
      return { success: false, message: 'Username sudah digunakan oleh akun Wali Santri lain.' };
    }

    const existingIdx = id
      ? list.findIndex(function (x) { return String(x.id) === id; })
      : -1;

    if (existingIdx !== -1) {
      const existing = list[existingIdx];
      let nextSalt = existing.salt || '';
      let nextHash = existing.passwordHash || '';
      if (password) {
        if (password.length < 4) return { success: false, message: 'Password minimal 4 karakter.' };
        nextSalt = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
        nextHash = computeSaltedSha256_(password, nextSalt);
      } else if (data.passwordHash && data.salt) {
        nextSalt = String(data.salt);
        nextHash = String(data.passwordHash);
      }
      list[existingIdx] = {
        id: existing.id,
        username: username,
        namaWali: namaWali || username,
        namaSantri: namaSantri,
        akses: akses,
        salt: nextSalt,
        passwordHash: nextHash,
        sharedSingle: false,
        createdAt: existing.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      writeWaliSantriStore_(list);
      return { success: true, id: existing.id };
    }

    // Upsert akun baru (termasuk yang dibuat offline dengan ID lokal)
    if (password && password.length < 4) {
      return { success: false, message: 'Password minimal 4 karakter.' };
    }
    const newId = id || ('ws_' + Date.now() + '_' + Utilities.getUuid().slice(0, 6));
    const salt = password
      ? Utilities.getUuid().replace(/-/g, '').slice(0, 16)
      : String(data.salt || '');
    const passwordHash = password
      ? computeSaltedSha256_(password, salt)
      : String(data.passwordHash || '');

    list.push({
      id: newId,
      username: username,
      namaWali: namaWali || username,
      namaSantri: namaSantri,
      akses: akses,
      salt: salt,
      passwordHash: passwordHash,
      sharedSingle: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    writeWaliSantriStore_(list);
    return { success: true, id: newId };
  });
}

function deleteWaliSantriUser(id) {
  return withScriptLock_(15000, function () {
    const targetId = String(id || '').trim();
    if (!targetId) return { success: false, message: 'ID akun tidak valid.' };
    const list = readWaliSantriStore_().filter(function (x) { return String(x.id) !== targetId; });
    writeWaliSantriStore_(list);
    return { success: true };
  });
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

  const perms = (Array.isArray(acc.akses) && acc.akses.length > 0) ? acc.akses : defaultWaliPerms;
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

// =========================================================================
// 5. MASTER DATA & DATABASE (TERMASUK KOLOM NFC CODE & QR CODE)
// =========================================================================

function getAppDataForRole() {
  const cached = getChunkedCache_('CORE_DATA_V1');
  if (cached) return cached;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const result = {
    santriWB: [],
    santriTakhassus: [],
    rooms: [],
    classes: [],
    musyrifs: [],
    pengajars: []
  };

  const sWB = ensureSheetReady_('Data_Wajib_Belajar', ss);
  if (sWB && sWB.getLastRow() > 1) {
    const rows = sWB.getDataRange().getValues();
    const hMap = findHeaderColMap_(rows[0]);
    const nfcCol = findHeaderColIndex_(hMap, 'nfc code');
    const qrCol = findHeaderColIndex_(hMap, 'qr code');
    const roomSet = new Set();
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] && rows[i][1]) {
        const kmr = String(rows[i][1]).trim();
        roomSet.add(kmr);
        result.santriWB.push({
          nama: String(rows[i][0]).trim(),
          kamar: kmr,
          nfcCode: nfcCol >= 0 ? String(rows[i][nfcCol] || '').trim() : '',
          qrCode: qrCol >= 0 ? String(rows[i][qrCol] || '').trim() : ''
        });
      }
    }
    result.rooms = Array.from(roomSet).sort();
  }

  const sTakh = ensureSheetReady_('Data_Santri_Takhassus', ss);
  if (sTakh && sTakh.getLastRow() > 1) {
    const rows = sTakh.getDataRange().getValues();
    const hMap = findHeaderColMap_(rows[0]);
    const nfcCol = findHeaderColIndex_(hMap, 'nfc code');
    const qrCol = findHeaderColIndex_(hMap, 'qr code');
    const classSet = new Set();
    for (let i = 1; i < rows.length; i++) {
      const nama = String(rows[i][1] || rows[i][0] || '').trim();
      const kelas = String(rows[i][2] || rows[i][1] || '').trim();
      const qismu = String(rows[i][3] || '').trim();
      if (nama && kelas) {
        classSet.add(kelas + (qismu ? ' - ' + qismu : ''));
        result.santriTakhassus.push({
          nama: nama,
          kelas: kelas,
          qismu: qismu,
          nfcCode: nfcCol >= 0 ? String(rows[i][nfcCol] || '').trim() : '',
          qrCode: qrCol >= 0 ? String(rows[i][qrCol] || '').trim() : ''
        });
      }
    }
    result.classes = Array.from(classSet).sort();
  }

  const sM = ensureSheetReady_('Data_Musyrif', ss);
  if (sM && sM.getLastRow() > 1) {
    const rows = sM.getDataRange().getValues();
    const hMap = findHeaderColMap_(rows[0]);
    const nfcCol = findHeaderColIndex_(hMap, 'nfc code');
    const qrCol = findHeaderColIndex_(hMap, 'qr code');
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0]) {
        result.musyrifs.push({
          nama: String(rows[i][0]).trim(),
          kamar: String(rows[i][1] || '').trim(),
          nfcCode: nfcCol >= 0 ? String(rows[i][nfcCol] || '').trim() : '',
          qrCode: qrCol >= 0 ? String(rows[i][qrCol] || '').trim() : ''
        });
      }
    }
  }

  const sP = ensureSheetReady_('Data_Pengajar_Takhassus', ss);
  if (sP && sP.getLastRow() > 1) {
    const rows = sP.getDataRange().getValues();
    const hMap = findHeaderColMap_(rows[0]);
    const nfcCol = findHeaderColIndex_(hMap, 'nfc code');
    const qrCol = findHeaderColIndex_(hMap, 'qr code');
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][1] || rows[i][0]) {
        result.pengajars.push({
          nama: String(rows[i][1] || rows[i][0]).trim(),
          kelas: String(rows[i][2] || '').trim(),
          qismu: String(rows[i][3] || '').trim(),
          nfcCode: nfcCol >= 0 ? String(rows[i][nfcCol] || '').trim() : '',
          qrCode: qrCol >= 0 ? String(rows[i][qrCol] || '').trim() : ''
        });
      }
    }
  }

  putChunkedCache_('CORE_DATA_V1', result, 180);
  return result;
}

function getDbSheetName_(type) {
  if (type === 'musyrif') return 'Data_Musyrif';
  if (type === 'pengajar') return 'Data_Pengajar_Takhassus';
  if (type === 'wb') return 'Data_Wajib_Belajar';
  return 'Data_Santri_Takhassus';
}

function getDbData(type) {
  const sheetName = getDbSheetName_(type);
  const sheet = ensureSheetReady_(sheetName);

  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  const hMap = findHeaderColMap_(data[0]);
  const nfcCol = findHeaderColIndex_(hMap, 'nfc code');
  const qrCol = findHeaderColIndex_(hMap, 'qr code');
  const pinCol = findHeaderColIndex_(hMap, 'pin');

  const result = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const nfcCode = nfcCol >= 0 ? String(row[nfcCol] || '').trim() : '';
    const qrCode = qrCol >= 0 ? String(row[qrCol] || '').trim() : '';

    if (type === 'musyrif') {
      if (!row[0]) continue;
      const pinVal = pinCol >= 0 ? String(row[pinCol] || '').trim() : String(row[2] || '').trim();
      result.push({
        idx: i + 1,
        f1: String(row[0] || '').trim(),
        f2: String(row[1] || '').trim(),
        f3: '',
        f4: pinVal,
        nfcCode: nfcCode,
        qrCode: qrCode
      });
    } else if (type === 'pengajar') {
      if (!row[1] && !row[0]) continue;
      const pinVal = pinCol >= 0 ? String(row[pinCol] || '').trim() : String(row[4] || '').trim();
      result.push({
        idx: i + 1,
        f1: String(row[1] || row[0] || '').trim(),
        f2: String(row[2] || '').trim(),
        f3: String(row[3] || '').trim(),
        f4: pinVal,
        nfcCode: nfcCode,
        qrCode: qrCode
      });
    } else if (type === 'wb') {
      if (!row[0]) continue;
      result.push({
        idx: i + 1,
        f1: String(row[0] || '').trim(),
        f2: String(row[1] || '').trim(),
        f3: '',
        f4: '',
        nfcCode: nfcCode,
        qrCode: qrCode
      });
    } else {
      if (!row[1] && !row[0]) continue;
      result.push({
        idx: i + 1,
        f1: String(row[1] || row[0] || '').trim(),
        f2: String(row[2] || '').trim(),
        f3: String(row[3] || '').trim(),
        f4: '',
        nfcCode: nfcCode,
        qrCode: qrCode
      });
    }
  }
  return result;
}

function saveDbData(type, index, obj) {
  return withScriptLock_(12000, function () {
    const sheetName = getDbSheetName_(type);
    const sheet = ensureSheetReady_(sheetName);

    const d = obj && typeof obj === 'object' ? obj : {};
    let targetRow = parseInt(index, 10);
    if (!targetRow || targetRow < 2) targetRow = sheet.getLastRow() + 1;

    if (type === 'musyrif') {
      const pinVal = String(d.f4 || d.f3 || '123456').trim();
      const colMapPin = ensureExtraHeaders_(sheet, ['PIN', 'NFC Code', 'QR Code']);
      sheet.getRange(targetRow, 1, 1, 2).setValues([[String(d.f1 || '').trim(), String(d.f2 || '').trim()]]);
      sheet.getRange(targetRow, colMapPin['PIN']).setValue(pinVal);
    } else if (type === 'pengajar') {
      const colMapPin = ensureExtraHeaders_(sheet, ['PIN', 'NFC Code', 'QR Code']);
      sheet.getRange(targetRow, 1, 1, 4).setValues([[targetRow - 1, String(d.f1 || '').trim(), String(d.f2 || '').trim(), String(d.f3 || '').trim()]]);
      sheet.getRange(targetRow, colMapPin['PIN']).setValue(String(d.f4 || '123456').trim());
    } else if (type === 'wb') {
      sheet.getRange(targetRow, 1, 1, 2).setValues([[String(d.f1 || '').trim(), String(d.f2 || '').trim()]]);
    } else {
      sheet.getRange(targetRow, 1, 1, 4).setValues([[targetRow - 1, String(d.f1 || '').trim(), String(d.f2 || '').trim(), String(d.f3 || '').trim()]]);
    }

    // Pastikan kolom NFC Code & QR Code selalu ada otomatis dan simpan nilainya
    const colMap = ensureExtraHeaders_(sheet, ['NFC Code', 'QR Code']);
    if (typeof d.nfcCode !== 'undefined') {
      sheet.getRange(targetRow, colMap['NFC Code']).setValue(String(d.nfcCode || '').trim());
    }
    if (typeof d.qrCode !== 'undefined') {
      sheet.getRange(targetRow, colMap['QR Code']).setValue(String(d.qrCode || '').trim());
    }

    SpreadsheetApp.flush();
    invalidateCaches_('master');
    return { success: true, idx: targetRow };
  });
}

function deleteDbData(type, index) {
  const sheetName = getDbSheetName_(type);
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  const rowNum = parseInt(index, 10);
  if (!sheet || !rowNum || rowNum < 2 || rowNum > sheet.getLastRow()) {
    return { success: false, message: 'Baris data tidak ditemukan.' };
  }
  sheet.deleteRow(rowNum);
  SpreadsheetApp.flush();
  invalidateCaches_('master');
  return { success: true };
}

// =========================================================================
// 6. ABSENSI (SUPPORT SINGLE-SCAN NFC/QR UPSERT + FINALISASI + REKAP)
// =========================================================================

function getAttendanceSheetName_(type) {
  if (type === 'takhassus') return 'Log_Absensi_Takhassus';
  if (type === 'musyrif') return 'Log_Absensi_Musyrif';
  if (type === 'pengajar') return 'Log_Absensi_Pengajar';
  return 'Log_Absensi_WB';
}

function checkExistingAbsensi(type, target, tglSesi) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(getAttendanceSheetName_(type));
  if (!sheet || sheet.getLastRow() <= 1) return false;
  const data = sheet.getDataRange().getValues();
  const targetClean = normGroupKey_(target);
  const tglClean = String(tglSesi || '').trim().slice(0, 10);
  for (let i = 1; i < data.length; i++) {
    const rowDate = formatRowDateWib_(data[i][2]);
    if (rowDate === tglClean && normGroupKey_(data[i][7]) === targetClean) return true;
  }
  return false;
}

/**
 * Menyimpan / memperbarui absensi per orang (Upsert berbasis Tgl_Sesi + Target + Nama):
 * - Mendukung single-scan NFC/QR 1-per-1 (`isSingleScanUpdate: true`)
 * - Mendukung edit pelanggaran saat kartu di-scan ulang pada hari yang sama
 * - Mendukung finalisasi sisa Izin/Alpa (`isSingleScanUpdate: false`) tanpa menolak kamar/kelas
 *   yang sebagian santrinya sudah masuk lewat scan NFC/QR!
 */
function submitAbsensi(payload) {
  return withScriptLock_(15000, function () {
    const p = payload && typeof payload === 'object' ? payload : {};
    const items = Array.isArray(p.items) ? p.items : [];
    if (items.length === 0) {
      return { success: false, message: 'Daftar absensi kosong.' };
    }

    const sheetName = getAttendanceSheetName_(p.type);
    const sheet = ensureSheetReady_(sheetName);
    const colMap = ensureExtraHeaders_(sheet, ['NFC Code', 'QR Code', 'Metode', 'Waktu_Scan']);
    const totalCols = Math.max(12, sheet.getLastColumn(), colMap['NFC Code'], colMap['QR Code'], colMap['Metode'], colMap['Waktu_Scan']);

    const now = new Date();
    const timestamp = Utilities.formatDate(now, TIMEZONE_WIB, 'yyyy-MM-dd HH:mm:ss');
    const tglSesi = String(p.tglSesi || Utilities.formatDate(now, TIMEZONE_WIB, 'yyyy-MM-dd')).trim().slice(0, 10);
    const tglParts = tglSesi.split('-');
    const tahun = tglParts[0] || Utilities.formatDate(now, TIMEZONE_WIB, 'yyyy');
    const bulan = tglParts[1] || Utilities.formatDate(now, TIMEZONE_WIB, 'MM');
    const targetLabel = String(p.target || '').trim();
    const targetNorm = normGroupKey_(targetLabel);
    const idSesi = targetLabel.replace(/\s+/g, '') + '_' + tglSesi;

    const existingRowByName = {};
    const existingRowDataByNum = {};
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      const existingData = sheet.getRange(2, 1, lastRow - 1, totalCols).getValues();
      for (let i = 0; i < existingData.length; i++) {
        const rDate = formatRowDateWib_(existingData[i][2]);
        if (rDate === tglSesi && normGroupKey_(existingData[i][7]) === targetNorm) {
          const rNameNorm = normKey_(existingData[i][8]);
          if (rNameNorm) {
            const rowNum = i + 2;
            existingRowByName[rNameNorm] = rowNum;
            existingRowDataByNum[rowNum] = existingData[i];
          }
        }
      }
    }

    const rowsToInsert = [];
    let updatedCount = 0;

    items.forEach(function (item) {
      const nama = String(item && item.nama || '').trim();
      if (!nama) return;
      const kehadiran = String(item.kehadiran || 'Hadir').trim();
      const pelArr = Array.isArray(item.pelanggaran)
        ? item.pelanggaran.map(function (x) { return String(x || '').trim(); }).filter(Boolean)
        : (typeof item.pelanggaran === 'string' && item.pelanggaran.trim()
            ? item.pelanggaran.split(',').map(function (x) { return x.trim(); }).filter(Boolean)
            : []);
      const pelStr = pelArr.join(', ');
      const poin = (p.type === 'wb' || p.type === 'takhassus') ? pelArr.length : 0;
      const nfcCode = String(item.nfcCode || '').trim();
      const qrCode = String(item.qrCode || '').trim();
      const metode = String(item.metodeAbsen || (item.autoScan ? 'SCAN' : 'MANUAL')).trim();
      const waktuScan = String(item.waktuScan || Utilities.formatDate(now, TIMEZONE_WIB, 'HH:mm:ss')).trim();

      const keyName = normKey_(nama);
      const existingRowNum = existingRowByName[keyName];

      if (existingRowNum && existingRowNum > 0) {
        const rowArr = (existingRowDataByNum[existingRowNum] || new Array(totalCols).fill('')).slice();
        while (rowArr.length < totalCols) rowArr.push('');
        rowArr[1] = timestamp;
        rowArr[6] = String(p.petugas || '').trim();
        rowArr[9] = kehadiran;
        rowArr[10] = pelStr;
        rowArr[11] = poin;
        if (nfcCode) rowArr[colMap['NFC Code'] - 1] = nfcCode;
        if (qrCode) rowArr[colMap['QR Code'] - 1] = qrCode;
        if (metode) rowArr[colMap['Metode'] - 1] = metode;
        if (waktuScan) rowArr[colMap['Waktu_Scan'] - 1] = waktuScan;
        sheet.getRange(existingRowNum, 1, 1, totalCols).setValues([rowArr]);
        updatedCount++;
      } else if (!existingRowNum) {
        const newRow = new Array(totalCols).fill('');
        newRow[0] = idSesi;
        newRow[1] = timestamp;
        newRow[2] = tglSesi;
        newRow[3] = tahun;
        newRow[4] = bulan;
        newRow[5] = String(p.role || '').trim();
        newRow[6] = String(p.petugas || '').trim();
        newRow[7] = targetLabel;
        newRow[8] = nama;
        newRow[9] = kehadiran;
        newRow[10] = pelStr;
        newRow[11] = poin;
        newRow[colMap['NFC Code'] - 1] = nfcCode;
        newRow[colMap['QR Code'] - 1] = qrCode;
        newRow[colMap['Metode'] - 1] = metode;
        newRow[colMap['Waktu_Scan'] - 1] = waktuScan;
        rowsToInsert.push(newRow);
        existingRowByName[keyName] = -1;
      }
    });

    if (rowsToInsert.length > 0) {
      sheet.getRange(sheet.getLastRow() + 1, 1, rowsToInsert.length, totalCols).setValues(rowsToInsert);
    }

    invalidateCaches_('absensi');

    return {
      success: true,
      inserted: rowsToInsert.length,
      updated: updatedCount,
      message: updatedCount > 0 && rowsToInsert.length === 0
        ? 'Data absensi & pelanggaran berhasil diperbarui!'
        : 'Absensi direkam!'
    };
  });
}

function getRekapData(activity) {
  const act = String(activity || 'wb').trim().toLowerCase();
  const chunkKey = 'REKAP_CHUNK_' + act;
  const hit = getChunkedCache_(chunkKey);
  if (Array.isArray(hit)) return hit;

  const sheet = ensureSheetReady_(getAttendanceSheetName_(act));
  if (!sheet || sheet.getLastRow() <= 1) return [];

  const data = sheet.getDataRange().getValues();
  const hMap = findHeaderColMap_(data[0]);
  const nfcCol = findHeaderColIndex_(hMap, 'nfc code');
  const qrCol = findHeaderColIndex_(hMap, 'qr code');
  const metCol = findHeaderColIndex_(hMap, 'metode');
  const jamCol = findHeaderColIndex_(hMap, 'waktu_scan');

  const list = [];
  for (let i = 1; i < data.length; i++) {
    if (!data[i][2]) continue;
    const rec = {
      tanggal: formatRowDateWib_(data[i][2]),
      target: String(data[i][7] || '').trim(),
      nama: String(data[i][8] || '').trim(),
      kehadiran: String(data[i][9] || '').trim(),
      pelanggaran: String(data[i][10] || '').trim(),
      poin: Number(data[i][11]) || 0
    };
    if (nfcCol >= 0 && data[i][nfcCol]) rec.nfcCode = String(data[i][nfcCol]).trim();
    if (qrCol >= 0 && data[i][qrCol]) rec.qrCode = String(data[i][qrCol]).trim();
    if (metCol >= 0 && data[i][metCol]) rec.metode = String(data[i][metCol]).trim();
    if (jamCol >= 0 && data[i][jamCol]) rec.waktuScan = String(data[i][jamCol]).trim();
    list.push(rec);
  }

  putChunkedCache_(chunkKey, list, 90);
  return list;
}

/**
 * Snapshot ringan khusus kehadiran 1 tanggal tertentu (default: hari ini WIB)
 * agar modul NFC/QR cepat mengetahui siapa saja yang SUDAH DIABSEN lintas perangkat.
 */
function getTodayAttendanceSnapshot(activity, tglSesi) {
  const act = String(activity || 'wb').trim().toLowerCase();
  const targetDate = String(tglSesi || Utilities.formatDate(new Date(), TIMEZONE_WIB, 'yyyy-MM-dd')).trim().slice(0, 10);
  const cacheKey = 'TODAY_SNAP_' + act + '_' + targetDate;
  const cache = CacheService.getScriptCache();
  try {
    const hit = cache.get(cacheKey);
    if (hit) return JSON.parse(hit);
  } catch (e) {}

  const allRows = getRekapData(act);
  const filtered = [];
  for (let i = 0; i < allRows.length; i++) {
    if (allRows[i].tanggal === targetDate) {
      filtered.push(allRows[i]);
    }
  }
  try {
    const ser = JSON.stringify(filtered);
    if (ser && ser.length < 95000) {
      cache.put(cacheKey, ser, 45);
      trackCacheKey_(cache, 'TODAY_SNAP_KEYS', cacheKey);
    }
  } catch (e) {}
  return filtered;
}

/**
 * Menghitung tunggakan absen harian & riwayat bulanan dengan CacheService + Fallback Anti-Error.
 * Sinkron 100% antara Beranda dan Menu Rekap & Tunggakan.
 */
function getMissingAttendance(tglSesi, selectedMonth) {
  const safeTgl = String(tglSesi || Utilities.formatDate(new Date(), TIMEZONE_WIB, 'yyyy-MM-dd')).trim().slice(0, 10);
  const targetMonth = String(selectedMonth || safeTgl.substring(0, 7)).trim().slice(0, 7);
  const cacheKey = 'MISSING_ATT_V2_' + safeTgl + '_' + targetMonth;
  const snapPropKey = 'ALRIFAIE_LAST_MISSING_SNAP_V1';
  const cache = CacheService.getScriptCache();

  try {
    const cached = cache.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (e) {}

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const partsMonth = targetMonth.split('-');
    const year = parseInt(partsMonth[0], 10);
    const month = parseInt(partsMonth[1], 10) - 1;

    const sLogWB = ss.getSheetByName('Log_Absensi_WB');
    const dataLogWB = sLogWB && sLogWB.getLastRow() > 1 ? sLogWB.getDataRange().getValues() : [];
    const sLogTakh = ss.getSheetByName('Log_Absensi_Takhassus');
    const dataLogTakh = sLogTakh && sLogTakh.getLastRow() > 1 ? sLogTakh.getDataRange().getValues() : [];

    // Indeks log per tanggal -> Set(normGroupKey(target)) sekali jalan (jauh lebih cepat & anti timeout!)
    const wbPresentByDate = {};
    let firstDateWB = null;
    for (let i = 1; i < dataLogWB.length; i++) {
      const rDate = formatRowDateWib_(dataLogWB[i][2]);
      if (!rDate || rDate.length < 10) continue;
      if (!firstDateWB || rDate < firstDateWB) firstDateWB = rDate;
      if (!wbPresentByDate[rDate]) wbPresentByDate[rDate] = {};
      const tgtNorm = normGroupKey_(dataLogWB[i][7]);
      if (tgtNorm) wbPresentByDate[rDate][tgtNorm] = true;
    }
    if (!firstDateWB) firstDateWB = safeTgl;

    const takhPresentByDate = {};
    let firstDateTakh = null;
    for (let i = 1; i < dataLogTakh.length; i++) {
      const rDate = formatRowDateWib_(dataLogTakh[i][2]);
      if (!rDate || rDate.length < 10) continue;
      if (!firstDateTakh || rDate < firstDateTakh) firstDateTakh = rDate;
      if (!takhPresentByDate[rDate]) takhPresentByDate[rDate] = {};
      const tgtNorm = normGroupKey_(dataLogTakh[i][7]);
      if (tgtNorm) takhPresentByDate[rDate][tgtNorm] = true;
    }
    if (!firstDateTakh) firstDateTakh = safeTgl;

    const partsToday = safeTgl.split('-');
    const todayLimit = new Date(parseInt(partsToday[0], 10), parseInt(partsToday[1], 10) - 1, parseInt(partsToday[2], 10));
    todayLimit.setHours(23, 59, 59, 999);

    const isOktober2026 = (year === 2026 && month === 9);
    const validDatesWB = [];
    const validDatesTakh = [];
    const dateCursor = new Date(year, month, 1);

    while (dateCursor.getMonth() === month) {
      if (dateCursor <= todayLimit) {
        const tglStr = Utilities.formatDate(dateCursor, TIMEZONE_WIB, 'yyyy-MM-dd');
        const dayOfWeek = dateCursor.getDay();
        const skipManual = isOktober2026 && tglStr < '2026-10-14';
        if (!skipManual) {
          if (dayOfWeek >= 0 && dayOfWeek <= 4 && tglStr >= firstDateWB) validDatesWB.push(tglStr);
          if (dayOfWeek === 5 && tglStr >= firstDateTakh) validDatesTakh.push(tglStr);
        }
      }
      dateCursor.setDate(dateCursor.getDate() + 1);
    }

    const riwayatTunggakan = {};
    let wbTargets = [];
    const sWB = ss.getSheetByName('Data_Wajib_Belajar');
    if (sWB && sWB.getLastRow() > 1) {
      const data = sWB.getDataRange().getValues();
      const set = new Set();
      for (let i = 1; i < data.length; i++) {
        if (data[i][1]) {
          const kmr = String(data[i][1]).trim();
          set.add(kmr);
          if (!riwayatTunggakan[kmr]) riwayatTunggakan[kmr] = [];
        }
      }
      wbTargets = Array.from(set).sort();
    }

    validDatesWB.forEach(function (dateToScan) {
      const presentMap = wbPresentByDate[dateToScan] || {};
      wbTargets.forEach(function (kmr) {
        if (!presentMap[normGroupKey_(kmr)]) riwayatTunggakan[kmr].push(dateToScan);
      });
    });

    const isCurrentMonth = (partsToday[0] === String(year) && partsToday[1] === String(month + 1).padStart(2, '0'));
    const daySesi = todayLimit.getDay();
    const isWBDay = (daySesi >= 0 && daySesi <= 4);
    const isTakhDay = (daySesi === 5);

    let wbTodayMissing = [];
    if (isCurrentMonth && isWBDay) {
      const todayWbPresent = wbPresentByDate[safeTgl] || {};
      wbTodayMissing = wbTargets.filter(function (kmr) {
        return !todayWbPresent[normGroupKey_(kmr)];
      });
    }

    let takhTargets = [];
    const sTakh = ss.getSheetByName('Data_Santri_Takhassus');
    if (sTakh && sTakh.getLastRow() > 1) {
      const data = sTakh.getDataRange().getValues();
      const set = new Set();
      for (let i = 1; i < data.length; i++) {
        const k = data[i][2] || data[i][1];
        const q = data[i][3] || '';
        if (k) {
          const trg = String(k + (q ? ' - ' + q : '')).trim();
          set.add(trg);
          if (!riwayatTunggakan[trg]) riwayatTunggakan[trg] = [];
        }
      }
      takhTargets = Array.from(set).sort();
    }

    validDatesTakh.forEach(function (dateToScan) {
      const presentMap = takhPresentByDate[dateToScan] || {};
      takhTargets.forEach(function (cls) {
        if (!presentMap[normGroupKey_(cls)]) riwayatTunggakan[cls].push(dateToScan);
      });
    });

    let takhTodayMissing = [];
    if (isCurrentMonth && isTakhDay) {
      const todayTakhPresent = takhPresentByDate[safeTgl] || {};
      takhTodayMissing = takhTargets.filter(function (cls) {
        return !todayTakhPresent[normGroupKey_(cls)];
      });
    }

    const result = {
      wb: wbTodayMissing.sort(),
      takhassus: takhTodayMissing.sort(),
      riwayat: riwayatTunggakan,
      scannedMonth: targetMonth
    };

    try {
      const serialized = JSON.stringify(result);
      if (serialized && serialized.length < 95000) {
        cache.put(cacheKey, serialized, 180);
        trackCacheKey_(cache, 'MISSING_ATT_V2_KEYS', cacheKey);
        if (serialized.length < 8000) {
          PropertiesService.getScriptProperties().setProperty(snapPropKey, serialized);
        }
      }
    } catch (cErr) {}

    return result;
  } catch (err) {
    Logger.log('Error getMissingAttendance, mencoba snapshot fallback: ' + err);
    try {
      const lastSnap = PropertiesService.getScriptProperties().getProperty(snapPropKey);
      if (lastSnap) return JSON.parse(lastSnap);
    } catch (sErr) {}
    return { wb: [], takhassus: [], riwayat: {}, scannedMonth: targetMonth };
  }
}

// =========================================================================
// 7. KEUANGAN TERPISAH: DANA SIMPANAN (Keuangan) & DANA OPERASIONAL
// =========================================================================

function getFinSheetName(category) {
  return category === 'operasional' ? 'Dana_Operasional' : 'Keuangan';
}

function getFinancialData(category) {
  const sheetName = getFinSheetName(category);
  const sheet = ensureSheetReady_(sheetName);
  if (!sheet || sheet.getLastRow() <= 1) return [];
  const data = sheet.getDataRange().getValues();
  const list = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i][1] || data[i][2]) {
      list.push({
        id: String(data[i][0] || ''),
        tanggal: (data[i][1] instanceof Date) ? Utilities.formatDate(data[i][1], TIMEZONE_WIB, 'dd-MM-yyyy') : String(data[i][1] || ''),
        keterangan: String(data[i][2] || ''),
        jenis: String(data[i][3] || ''),
        jumlah: Number(data[i][4]) || 0
      });
    }
  }
  return list;
}

function saveFinancialData(item, category) {
  const it = item && typeof item === 'object' ? item : {};
  const cat = category || it.category || 'simpanan';
  const sheetName = getFinSheetName(cat);
  const sheet = ensureSheetReady_(sheetName);
  const prefix = cat === 'operasional' ? 'OPR_' : 'FIN_';
  const id = prefix + new Date().getTime();
  sheet.appendRow([id, it.tanggal, safeSheetCell_(it.keterangan, 300), it.jenis, Number(it.jumlah) || 0]);
  SpreadsheetApp.flush();
  return { success: true, id: id };
}

function deleteFinancialData(id, category) {
  const sheetName = getFinSheetName(category);
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) return { success: false };
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      sheet.deleteRow(i + 1);
      SpreadsheetApp.flush();
      return { success: true };
    }
  }
  return { success: false };
}

// =========================================================================
// 8. PENGUMUMAN, KOTAK SARAN & ARSIP SURAT (TERMASUK SURAT SP + DRIVE PDF)
// =========================================================================

function getPengumuman() {
  const sheet = ensureSheetReady_('Pengumuman');
  if (!sheet || sheet.getLastRow() <= 1) return [];
  const data = sheet.getDataRange().getValues();
  const list = [];
  for (let i = data.length - 1; i >= 1; i--) {
    list.push({
      id: String(data[i][0] || ''),
      tanggal: (data[i][1] instanceof Date) ? Utilities.formatDate(data[i][1], TIMEZONE_WIB, 'dd MMM yyyy HH:mm') : String(data[i][1] || ''),
      isi: String(data[i][2] || ''),
      penulis: String(data[i][3] || '')
    });
  }
  return list;
}

function savePengumuman(isi, penulis, role) {
  if (role !== 'admin') return { success: false, message: 'Akses ditolak!' };
  const sheet = ensureSheetReady_('Pengumuman');
  const id = 'PGM_' + new Date().getTime();
  sheet.appendRow([id, Utilities.formatDate(new Date(), TIMEZONE_WIB, 'yyyy-MM-dd HH:mm:ss'), safeSheetCell_(isi, 1000), safeSheetCell_(penulis, 120)]);
  SpreadsheetApp.flush();
  invalidateCaches_('pengumuman');
  return { success: true, id: id };
}

function deletePengumuman(id, role) {
  if (role !== 'admin') return { success: false, message: 'Akses ditolak!' };
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Pengumuman');
  if (!sheet) return { success: false };
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      sheet.deleteRow(i + 1);
      SpreadsheetApp.flush();
      invalidateCaches_('pengumuman');
      return { success: true };
    }
  }
  return { success: false };
}

function getSaran() {
  const sheet = ensureSheetReady_('Kotak_Saran');
  if (!sheet || sheet.getLastRow() <= 1) return [];
  const data = sheet.getDataRange().getValues();
  const list = [];
  for (let i = data.length - 1; i >= 1; i--) {
    list.push({
      id: String(data[i][0] || ''),
      tanggal: (data[i][1] instanceof Date) ? Utilities.formatDate(data[i][1], TIMEZONE_WIB, 'dd MMM yyyy HH:mm') : String(data[i][1] || ''),
      peran: String(data[i][2] || ''),
      nama: String(data[i][3] || ''),
      isi: String(data[i][4] || '')
    });
  }
  return list;
}

function saveSaran(peran, nama, isi) {
  const sheet = ensureSheetReady_('Kotak_Saran');
  const id = 'SRN_' + new Date().getTime();
  sheet.appendRow([id, Utilities.formatDate(new Date(), TIMEZONE_WIB, 'yyyy-MM-dd HH:mm:ss'), safeSheetCell_(peran, 60), safeSheetCell_(nama, 120), safeSheetCell_(isi, 1000)]);
  SpreadsheetApp.flush();
  return { success: true, id: id };
}

function deleteSaran(id) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Kotak_Saran');
  if (!sheet) return { success: false };
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      sheet.deleteRow(i + 1);
      SpreadsheetApp.flush();
      return { success: true };
    }
  }
  return { success: false };
}

function getSurat() {
  const sheet = ensureSheetReady_('Surat');
  if (!sheet || sheet.getLastRow() <= 1) return [];
  const data = sheet.getDataRange().getValues();
  const hMap = findHeaderColMap_(data[0]);
  const driveUrlCol = findHeaderColIndex_(hMap, 'drive_url');
  const driveIdCol = findHeaderColIndex_(hMap, 'drive_file_id');
  const suratMap = readSuratDriveMap_();

  const list = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i][3] || data[i][4] || data[i][6]) {
      const id = String(data[i][0] || '');
      const nomor = String(data[i][3] || '');
      const perihal = String(data[i][4] || '');
      let driveUrl = driveUrlCol >= 0 ? String(data[i][driveUrlCol] || '').trim() : '';
      let driveFileId = driveIdCol >= 0 ? String(data[i][driveIdCol] || '').trim() : '';

      if (!driveUrl) {
        const key = normalizeSuratDriveKey_(nomor, perihal);
        const meta = suratMap['id_' + id] || suratMap[key];
        if (meta && meta.viewUrl) {
          driveUrl = meta.viewUrl;
          driveFileId = meta.fileId || '';
        }
      }

      list.push({
        id: id,
        kategori: String(data[i][1] || ''),
        sub: String(data[i][2] || ''),
        nomor: nomor,
        perihal: perihal,
        tanggal: (data[i][5] instanceof Date) ? Utilities.formatDate(data[i][5], TIMEZONE_WIB, 'dd-MM-yyyy') : String(data[i][5] || ''),
        tujuan: String(data[i][6] || ''),
        driveUrl: driveUrl,
        driveFileId: driveFileId
      });
    }
  }
  return list;
}

function saveSuratData(item) {
  return withScriptLock_(15000, function () {
    const sheet = ensureSheetReady_('Surat');
    const it = item && typeof item === 'object' ? item : {};
    const id = String(it.id || ('SRT_' + new Date().getTime()));
    const htmlSnap = String(it.driveHtmlSnapshot || '');
    const colMap = ensureExtraHeaders_(sheet, ['Drive_URL', 'Drive_File_ID']);
    const totalCols = Math.max(7, sheet.getLastColumn(), colMap['Drive_URL'], colMap['Drive_File_ID']);

    let driveMeta = null;
    const driveCfg = getDriveBackupConfig_();
    if (driveCfg.enabled && driveCfg.backupSurat) {
      try {
        driveMeta = backupSuratHtmlToDriveInternal_(it, htmlSnap, id);
      } catch (drvErr) {
        Logger.log('Info backup Drive surat: ' + drvErr);
      }
    }

    const row = new Array(totalCols).fill('');
    row[0] = id;
    row[1] = String(it.kategori || 'Lainnya');
    row[2] = String(it.sub || '');
    row[3] = String(it.nomor || '-');
    row[4] = String(it.perihal || '');
    row[5] = String(it.tanggal || Utilities.formatDate(new Date(), TIMEZONE_WIB, 'dd-MM-yyyy'));
    row[6] = String(it.tujuan || '');
    row[colMap['Drive_URL'] - 1] = driveMeta ? driveMeta.viewUrl : String(it.driveUrl || '');
    row[colMap['Drive_File_ID'] - 1] = driveMeta ? driveMeta.fileId : String(it.driveFileId || '');

    sheet.getRange(sheet.getLastRow() + 1, 1, 1, totalCols).setValues([row]);
    SpreadsheetApp.flush();

    return {
      success: true,
      id: id,
      driveBackedUp: Boolean(driveMeta && driveMeta.viewUrl),
      driveFileId: driveMeta ? driveMeta.fileId : '',
      driveUrl: driveMeta ? driveMeta.viewUrl : ''
    };
  });
}

function deleteSurat(id) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Surat');
  if (!sheet) return { success: false };
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      sheet.deleteRow(i + 1);
      SpreadsheetApp.flush();
      return { success: true };
    }
  }
  return { success: false };
}

// =========================================================================
// 9. GALERI KEGIATAN SANTRI (AUTO CADANGAN KE GOOGLE DRIVE)
// =========================================================================

function getGaleriSheet_() {
  return ensureSheetReady_('Galeri');
}

function saveGaleriData(item) {
  return withScriptLock_(15000, function () {
    const sh = getGaleriSheet_();
    const colMap = ensureExtraHeaders_(sh, ['Likes', 'LikedBy', 'Drive_URL', 'Drive_File_ID']);
    const totalCols = Math.max(9, sh.getLastColumn(), colMap['Drive_URL'], colMap['Drive_File_ID']);
    const it = item && typeof item === 'object' ? item : {};
    const id = String(it.id || ('g' + Date.now()));
    const tglStr = it.tanggal ? String(it.tanggal) : Utilities.formatDate(new Date(), TIMEZONE_WIB, 'yyyy-MM-dd');

    let publicUrl = String(it.imageUrl || '');
    let driveMeta = null;
    const driveCfg = getDriveBackupConfig_();
    if (publicUrl.indexOf('data:image/') === 0 && driveCfg.enabled && driveCfg.backupGaleri) {
      try {
        driveMeta = saveHdImageToDrive_(publicUrl, 'galeri_santri', 'Galeri_Santri');
        if (driveMeta && driveMeta.url) publicUrl = driveMeta.url;
      } catch (drvErr) {
        Logger.log('Fallback galeri Drive: ' + drvErr);
        publicUrl = saveImageToDrive_(publicUrl, 'galeri_' + Date.now() + '.jpg', 'Galeri_Santri');
      }
    }

    const row = new Array(totalCols).fill('');
    row[0] = id;
    row[1] = String(it.penulis || 'Petugas');
    row[2] = String(it.jabatan || '');
    row[3] = "'" + tglStr;
    row[4] = String(it.tag || '');
    row[5] = String(it.caption || '');
    row[6] = publicUrl;
    row[colMap['Likes'] - 1] = 0;
    row[colMap['LikedBy'] - 1] = '[]';
    row[colMap['Drive_URL'] - 1] = driveMeta ? driveMeta.viewUrl : '';
    row[colMap['Drive_File_ID'] - 1] = driveMeta ? driveMeta.fileId : '';

    sh.getRange(sh.getLastRow() + 1, 1, 1, totalCols).setValues([row]);
    SpreadsheetApp.flush();
    invalidateCaches_('galeri');

    return {
      success: true,
      id: id,
      imageUrl: publicUrl,
      driveBackedUp: Boolean(driveMeta && driveMeta.viewUrl),
      driveFileId: driveMeta ? driveMeta.fileId : '',
      driveUrl: driveMeta ? driveMeta.viewUrl : ''
    };
  });
}

function getGaleriData() {
  const cache = CacheService.getScriptCache();
  try {
    const hit = cache.get('GALERI_CACHE_V1');
    if (hit) return JSON.parse(hit);
  } catch (e) {}

  const sh = getGaleriSheet_();
  if (!sh || sh.getLastRow() < 2) return [];

  const allVals = sh.getDataRange().getValues();
  const hMap = findHeaderColMap_(allVals[0]);
  const driveUrlCol = findHeaderColIndex_(hMap, 'drive_url');
  const driveIdCol = findHeaderColIndex_(hMap, 'drive_file_id');
  const result = [];

  for (let i = allVals.length - 1; i >= 1; i--) {
    const r = allVals[i];
    if (!r[0] && !r[6]) continue;

    const tglFormatted = (r[3] instanceof Date)
      ? Utilities.formatDate(r[3], TIMEZONE_WIB, 'yyyy-MM-dd')
      : String(r[3] || '');

    let likedArr = [];
    try {
      likedArr = r[8] ? JSON.parse(String(r[8])) : [];
      if (!Array.isArray(likedArr)) likedArr = [];
    } catch (e) {
      likedArr = [];
    }

    result.push({
      id: String(r[0] || ''),
      penulis: String(r[1] || 'Petugas'),
      jabatan: String(r[2] || ''),
      tanggal: tglFormatted,
      tag: String(r[4] || ''),
      caption: String(r[5] || ''),
      imageUrl: String(r[6] || ''),
      likes: Number(r[7]) || 0,
      likedBy: likedArr,
      driveUrl: driveUrlCol >= 0 ? String(r[driveUrlCol] || '').trim() : '',
      driveFileId: driveIdCol >= 0 ? String(r[driveIdCol] || '').trim() : ''
    });
  }

  try {
    const ser = JSON.stringify(result);
    if (ser && ser.length < 95000) cache.put('GALERI_CACHE_V1', ser, 90);
  } catch (e) {}
  return result;
}

function toggleGaleriLike(id, userName) {
  const sh = getGaleriSheet_();
  if (sh.getLastRow() < 2) return { success: false };
  const data = sh.getDataRange().getValues();
  const targetId = String(id);
  const cleanUser = String(userName || 'Guest').trim();

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === targetId) {
      let likedBy = [];
      try {
        likedBy = data[i][8] ? JSON.parse(String(data[i][8])) : [];
        if (!Array.isArray(likedBy)) likedBy = [];
      } catch (e) {
        likedBy = [];
      }

      const idx = likedBy.indexOf(cleanUser);
      if (idx >= 0) likedBy.splice(idx, 1);
      else likedBy.push(cleanUser);

      sh.getRange(i + 1, 8, 1, 2).setValues([[likedBy.length, JSON.stringify(likedBy)]]);
      SpreadsheetApp.flush();
      invalidateCaches_('galeri');
      return { success: true, likes: likedBy.length, likedBy: likedBy };
    }
  }
  return { success: false };
}

function deleteGaleriData(id) {
  const sh = getGaleriSheet_();
  if (sh.getLastRow() < 2) return { success: false };
  const data = sh.getDataRange().getValues();
  const targetId = String(id);

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === targetId) {
      sh.deleteRow(i + 1);
      SpreadsheetApp.flush();
      invalidateCaches_('galeri');
      return { success: true };
    }
  }
  return { success: false };
}

// =========================================================================
// 10. IZIN DIGITAL (AUTO-REJECT LEWAT BATAS WAKTU ADMIN) & LOG TINDAKAN
// =========================================================================

function getOrCreateIzinSheet_() {
  return ensureSheetReady_(IZIN_DIGITAL_SHEET_NAME);
}

function getIzinDigital() {
  try {
    const sh = getOrCreateIzinSheet_();
    const lastRow = sh.getLastRow();
    if (lastRow <= 1) return [];
    const rows = sh.getRange(2, 1, lastRow - 1, Math.max(13, sh.getLastColumn())).getValues();
    const out = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (!r[0]) continue;
      out.push({
        id: String(r[0]),
        namaSantri: String(r[1] || ''),
        kamarKelas: String(r[2] || ''),
        jenis: String(r[3] || 'Sakit'),
        startDate: formatRowDateWib_(r[4]),
        endDate: formatRowDateWib_(r[5]),
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

function saveIzinDigital(payload) {
  return withScriptLock_(15000, function () {
    const d = payload && typeof payload === 'object' ? payload : {};
    const namaPemohon = safeSheetCell_(d.namaSantri || d.namaPemohon || d.pengaju, 120);
    const unitTugas = safeSheetCell_(d.kamarKelas || d.unitTugas, 100);
    const allowedJenis = ['Sakit', 'Keperluan Keluarga', 'Tugas Luar / Dinas', 'Izin Pribadi', 'Pulang', 'Dispensasi'];
    const jenis = allowedJenis.indexOf(String(d.jenis || '')) !== -1 ? String(d.jenis) : 'Izin Pribadi';
    const startDate = String(d.startDate || '').trim().slice(0, 10);
    const endDate = String(d.endDate || startDate).trim().slice(0, 10);
    const alasan = safeSheetCell_(d.alasan, 400);
    const pengaju = safeSheetCell_(d.pengaju || namaPemohon, 100);
    const peranPengaju = String(d.peranPengaju || 'musyrif').trim().toLowerCase();

    if (['musyrif', 'pengajar', 'admin', 'user'].indexOf(peranPengaju) === -1) {
      return { success: false, message: 'Izin Digital hanya diperuntukkan bagi Musyrif, Pengajar, Pengurus, atau Admin.' };
    }
    if (!namaPemohon || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || endDate < startDate) {
      return { success: false, message: 'Nama pemohon dan rentang tanggal izin wajib valid.' };
    }

    const sh = getOrCreateIzinSheet_();
    const id = String(d.id || ('iz_' + Date.now() + '_' + Utilities.getUuid().slice(0, 6))).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60);

    // Gunakan waktu pengajuan asli (untuk sinkronisasi offline) bila valid dan tidak di masa depan
    let refDate = new Date();
    if (d.createdAt) {
      const parsedCreated = new Date(String(d.createdAt));
      if (!isNaN(parsedCreated.getTime()) && parsedCreated.getTime() <= Date.now() + 300000) {
        refDate = parsedCreated;
      }
    }

    let initialStatus = (peranPengaju === 'admin') ? 'Disetujui' : 'Menunggu';
    let diprosesOleh = (peranPengaju === 'admin') ? pengaju : '';
    let catatanAdmin = safeSheetCell_(d.catatanAdmin || '', 300);
    let autoRejected = false;

    if (peranPengaju !== 'admin') {
      try {
        const rawDl = PropertiesService.getScriptProperties().getProperty('ALRIFAIE_ATTENDANCE_DEADLINES');
        const dlCfg = rawDl ? JSON.parse(rawDl) : null;
        const izinCfg = dlCfg && dlCfg.izinDigital ? dlCfg.izinDigital : { enabled: true, time: '16:00' };
        if (izinCfg && izinCfg.enabled && /^\d{2}:\d{2}$/.test(String(izinCfg.time || ''))) {
          const todayWib = Utilities.formatDate(refDate, TIMEZONE_WIB, 'yyyy-MM-dd');
          const nowTimeWib = Utilities.formatDate(refDate, TIMEZONE_WIB, 'HH:mm');
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

    const createdAt = refDate.toISOString();
    const rowValues = [id, namaPemohon, unitTugas, jenis, "'" + startDate, "'" + endDate, alasan, pengaju, peranPengaju, initialStatus, diprosesOleh, catatanAdmin, createdAt];

    // Upsert berdasarkan ID agar retry antrean offline tidak pernah membuat baris ganda
    let existingRow = -1;
    const lastRow = sh.getLastRow();
    if (lastRow > 1) {
      const ids = sh.getRange(2, 1, lastRow - 1, 1).getValues();
      for (let i = 0; i < ids.length; i++) {
        if (String(ids[i][0]) === id) {
          existingRow = i + 2;
          break;
        }
      }
    }
    if (existingRow >= 2) {
      sh.getRange(existingRow, 1, 1, rowValues.length).setValues([rowValues]);
    } else {
      sh.appendRow(rowValues);
    }
    SpreadsheetApp.flush();

    return {
      success: true,
      id: id,
      status: initialStatus,
      autoRejected: autoRejected,
      diprosesOleh: diprosesOleh,
      catatanAdmin: catatanAdmin
    };
  });
}

function updateIzinDigitalStatus(id, nextStatus, approverName, catatanAdmin) {
  return withScriptLock_(15000, function () {
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
        sh.getRange(rowNum, 10, 1, 3).setValues([[
          String(nextStatus),
          safeSheetCell_(approverName, 100),
          safeSheetCell_(catatanAdmin, 300)
        ]]);
        SpreadsheetApp.flush();
        return { success: true };
      }
    }
    return { success: false, message: 'Data izin tidak ditemukan.' };
  });
}

function deleteIzinDigital(id) {
  return withScriptLock_(15000, function () {
    const targetId = String(id || '').trim();
    if (!targetId) return { success: false, message: 'ID izin tidak valid.' };
    const sh = getOrCreateIzinSheet_();
    const lastRow = sh.getLastRow();
    if (lastRow <= 1) return { success: true };
    const ids = sh.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = ids.length - 1; i >= 0; i--) {
      if (String(ids[i][0]) === targetId) {
        sh.deleteRow(i + 2);
        SpreadsheetApp.flush();
        return { success: true };
      }
    }
    return { success: true };
  });
}

function getOrCreateTindakanSheet_() {
  return ensureSheetReady_(TINDAKAN_SANTRI_SHEET_NAME);
}

function getSantriTindakan() {
  try {
    const sh = getOrCreateTindakanSheet_();
    const lastRow = sh.getLastRow();
    if (lastRow <= 1) return [];
    const rows = sh.getRange(2, 1, lastRow - 1, Math.max(8, sh.getLastColumn())).getValues();
    const out = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (!r[0]) continue;
      out.push({
        id: String(r[0]),
        tanggal: formatRowDateWib_(r[1]),
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
  return withScriptLock_(15000, function () {
    const d = payload && typeof payload === 'object' ? payload : {};
    const namaSantri = safeSheetCell_(d.namaSantri, 120);
    const tindakan = safeSheetCell_(d.tindakan, 120);
    if (!namaSantri || !tindakan) {
      return { success: false, message: 'Nama santri dan jenis tindakan wajib diisi.' };
    }
    const sh = getOrCreateTindakanSheet_();
    const id = String(d.id || ('tnd_' + Date.now() + '_' + Utilities.getUuid().slice(0, 6))).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60);
    const rawDate = String(d.tanggal || '').trim().slice(0, 10);
    const tanggal = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : Utilities.formatDate(new Date(), TIMEZONE_WIB, 'yyyy-MM-dd');
    const rowValues = [
      id,
      "'" + tanggal,
      namaSantri,
      safeSheetCell_(d.kamarKelas, 100),
      tindakan,
      safeSheetCell_(d.catatan, 400),
      safeSheetCell_(d.petugas, 100),
      safeSheetCell_(d.peranPetugas, 40)
    ];

    let existingRow = -1;
    const lastRow = sh.getLastRow();
    if (lastRow > 1) {
      const ids = sh.getRange(2, 1, lastRow - 1, 1).getValues();
      for (let i = 0; i < ids.length; i++) {
        if (String(ids[i][0]) === id) {
          existingRow = i + 2;
          break;
        }
      }
    }
    if (existingRow >= 2) {
      sh.getRange(existingRow, 1, 1, rowValues.length).setValues([rowValues]);
    } else {
      sh.appendRow(rowValues);
    }
    SpreadsheetApp.flush();
    return { success: true, id: id };
  });
}

function deleteSantriTindakan(id) {
  return withScriptLock_(15000, function () {
    const targetId = String(id || '').trim();
    if (!targetId) return { success: false };
    const sh = getOrCreateTindakanSheet_();
    const lastRow = sh.getLastRow();
    if (lastRow <= 1) return { success: true };
    const ids = sh.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = ids.length - 1; i >= 0; i--) {
      if (String(ids[i][0]) === targetId) {
        sh.deleteRow(i + 2);
        SpreadsheetApp.flush();
        return { success: true };
      }
    }
    return { success: true };
  });
}

// =========================================================================
// 11. HELPER OTORISASI & AUTO-SETUP SEMUA SHEET + KOLOM (NFC, QR, DRIVE, DLL.)
// =========================================================================

function setupSemuaSheetDanKolom() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const schemaReport = ensureAllSheetsAndColumns_(true);
  // Migrasi otomatis data lama Wali Santri (jika pernah tersimpan di PropertiesService) ke Sheet Akun_Wali_Santri
  try { readWaliSantriStore_(); } catch (e) {}
  SpreadsheetApp.flush();
  return {
    success: true,
    spreadsheet: ss.getName(),
    schema: schemaReport
  };
}

function testAuthorizationAndSetup() {
  const setupRes = setupSemuaSheetDanKolom();
  const driveStatus = getDriveBackupStatus();
  Logger.log('Spreadsheet terhubung: ' + setupRes.spreadsheet);
  Logger.log('Hasil auto-setup sheet & kolom: ' + JSON.stringify(setupRes.schema));
  Logger.log('Google Drive status: ' + JSON.stringify(driveStatus));
  return {
    success: true,
    spreadsheet: setupRes.spreadsheet,
    schema: setupRes.schema,
    drive: driveStatus
  };
}
