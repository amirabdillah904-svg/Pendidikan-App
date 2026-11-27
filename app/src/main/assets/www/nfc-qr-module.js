/**
 * =========================================================================
 * MODUL ABSENSI NFC & QR CODE + MANAJEMEN IDENTITAS DATABASE
 * Departemen Pendidikan - YPM Al-Rifa'ie 2
 * =========================================================================
 * Alur Sederhana & Anti-Ribet:
 * 1. Saat kartu NFC ditempel atau QR Code di-scan -> langsung muncul popup pilihan
 *    pelanggaran (opsional) -> 1 klik langsung otomatis tersimpan ke database &
 *    tercentang Hadir di daftar nama (tanpa perlu kirim ulang!).
 *    (Jika kartu NFC berikutnya langsung ditempel sebelum klik, santri sebelumnya
 *    otomatis tersimpan Hadir sesuai pilihan saat itu agar antrean super cepat!)
 * 2. Nama yang belum scan berstatus "Belum Verifikasi".
 * 3. Tombol "Input Izin / Alpa" hanya menampilkan nama yang BELUM terverifikasi
 *    untuk dipilih Izin / Alpa lalu dikirim ke database.
 */
(function (global) {
  'use strict';

  const REGISTRY_KEY = 'alrifaie_id_registry_v1';
  const VERIFIED_TODAY_KEY = 'alrifaie_verified_today_v1';

  let activeTabName = 'home';
  let nfcBindListening = false;
  let nfcStatusState = { supported: false, enabled: false, locked: false, mode: 'idle' };

  // QR Scanner runtime state
  let qrStream = null;
  let qrScanRaf = null;
  let qrScanActive = false;
  let qrScanPausedForConfirm = false;
  let qrScanMode = 'attendance'; // 'attendance' | 'bind_db'
  let qrScanTargetType = 'wb';
  let qrTorchOn = false;
  let qrLastCode = '';
  let qrLastTime = 0;
  let qrBarcodeDetector = null;
  let qrCanvas = null;
  let qrCanvasCtx = null;
  let jsQrLoadingPromise = null;
  let activeQrPreviewItem = null;

  // Pending scan confirmation popup state (NFC / QR -> pilih pelanggaran -> auto simpan)
  let pendingScanConfirm = null;
  let qrPauseTimer = null;
  let lastHandledPersonKey = '';
  let lastHandledPersonTime = 0;

  // Modal Input Izin / Alpa state (hanya menampilkan nama yang belum terverifikasi)
  let activeIzinAlpaContext = null; // { type, target, tglSesi, items: [{ nama, nfcCode, qrCode, choice }] }

  function normText(v) {
    return String(v || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function normCode(v) {
    return String(v || '').trim().replace(/[:\-\s]/g, '').toUpperCase();
  }

  function normRawCode(v) {
    return String(v || '').trim().toUpperCase();
  }

  function escAttr(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function getTodayDateStr() {
    if (typeof global.getWIBDateString === 'function') return global.getWIBDateString();
    const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function getWibTimeStr() {
    const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
    return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' WIB';
  }

  function vibrateSafe(ms) {
    try {
      if (global.AndroidBridge && typeof global.AndroidBridge.vibrateFeedback === 'function') {
        global.AndroidBridge.vibrateFeedback(ms || 50);
        return;
      }
      if (navigator.vibrate) navigator.vibrate(ms || 50);
    } catch (e) {}
  }

  // ===================== 1. REGISTRY IDENTITAS NFC & QR =====================
  function loadRegistry() {
    try {
      const raw = localStorage.getItem(REGISTRY_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function saveRegistry(reg) {
    try {
      localStorage.setItem(REGISTRY_KEY, JSON.stringify(reg || {}));
    } catch (e) {}
  }

  function registryKey(type, nama) {
    return String(type || '').toLowerCase() + '|' + normText(nama);
  }

  function shortHash(str) {
    let h = 2166136261;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36).toUpperCase().padStart(6, '0').slice(0, 6);
  }

  function generateDeterministicQrCode(type, nama, group) {
    const prefixMap = {
      musyrif: 'MUS',
      pengajar: 'PNG',
      wb: 'WB',
      takhassus: 'TKH'
    };
    const prefix = prefixMap[type] || 'ID';
    const seed = prefix + '|' + normText(nama) + '|' + normText(group || '');
    return prefix + '-' + shortHash(seed);
  }

  function getIdentity(type, nama, serverObj) {
    const reg = loadRegistry();
    const key = registryKey(type, nama);
    const localRec = reg[key] || {};

    const serverNfc = serverObj ? String(serverObj.nfcCode || serverObj.nfc || '').trim() : '';
    const serverQr = serverObj ? String(serverObj.qrCode || serverObj.qr || '').trim() : '';

    let nfcCode = serverNfc || localRec.nfcCode || '';
    let qrCode = serverQr || localRec.qrCode || '';

    if (!qrCode && (type === 'musyrif' || type === 'pengajar') && nama) {
      const grp = serverObj ? (serverObj.f2 || serverObj.kamar || serverObj.kelas || '') : '';
      qrCode = generateDeterministicQrCode(type, nama, grp);
      reg[key] = { nfcCode: nfcCode, qrCode: qrCode, updatedAt: Date.now() };
      saveRegistry(reg);
    } else if ((serverNfc && serverNfc !== localRec.nfcCode) || (serverQr && serverQr !== localRec.qrCode)) {
      reg[key] = { nfcCode: nfcCode, qrCode: qrCode, updatedAt: Date.now() };
      saveRegistry(reg);
    }

    return { nfcCode: nfcCode, qrCode: qrCode };
  }

  function setIdentity(type, nama, nfcCode, qrCode) {
    if (!nama) return;
    const reg = loadRegistry();
    const key = registryKey(type, nama);
    reg[key] = {
      nfcCode: String(nfcCode || '').trim().toUpperCase(),
      qrCode: String(qrCode || '').trim().toUpperCase(),
      updatedAt: Date.now()
    };
    saveRegistry(reg);
  }

  function syncServerCoreDataToRegistry() {
    try {
      const cd = global.coreData || {};
      const md = global.masterData || {};
      const reg = loadRegistry();
      let changed = false;

      const absorb = (type, list) => {
        if (!Array.isArray(list)) return;
        list.forEach(item => {
          const nama = typeof item === 'object' ? (item.nama || item.f1 || '') : String(item || '');
          if (!nama) return;
          const key = registryKey(type, nama);
          const cur = reg[key] || { nfcCode: '', qrCode: '' };
          const sNfc = typeof item === 'object' ? String(item.nfcCode || item.nfc || '').trim().toUpperCase() : '';
          const sQr = typeof item === 'object' ? String(item.qrCode || item.qr || '').trim().toUpperCase() : '';
          const nextNfc = sNfc || cur.nfcCode || '';
          let nextQr = sQr || cur.qrCode || '';
          if (!nextQr && (type === 'musyrif' || type === 'pengajar')) {
            nextQr = generateDeterministicQrCode(type, nama, typeof item === 'object' ? (item.kamar || item.kelas || item.f2 || '') : '');
          }
          if (nextNfc !== cur.nfcCode || nextQr !== cur.qrCode) {
            reg[key] = { nfcCode: nextNfc, qrCode: nextQr, updatedAt: Date.now() };
            changed = true;
          }
        });
      };

      absorb('wb', cd.santriWB);
      absorb('takhassus', cd.santriTakhassus);
      absorb('musyrif', (cd.musyrifs && cd.musyrifs.length) ? cd.musyrifs : md.musyrifs);
      absorb('pengajar', (cd.pengajars && cd.pengajars.length) ? cd.pengajars : md.pengajars);

      if (changed) saveRegistry(reg);
    } catch (e) {
      console.warn('syncServerCoreDataToRegistry:', e);
    }
  }

  function getAllMembersForType(type) {
    const cd = global.coreData || {};
    const md = global.masterData || {};
    if (type === 'wb') {
      return (cd.santriWB || []).map(s => ({
        type: 'wb',
        nama: typeof s === 'object' ? String(s.nama || '').trim() : String(s || '').trim(),
        target: typeof s === 'object' ? String(s.kamar || '').trim() : '',
        raw: s
      })).filter(x => x.nama);
    }
    if (type === 'takhassus') {
      return (cd.santriTakhassus || []).map(s => {
        const kelas = typeof s === 'object' ? String(s.kelas || '').trim() : '';
        const qismu = typeof s === 'object' ? String(s.qismu || '').trim() : '';
        return {
          type: 'takhassus',
          nama: typeof s === 'object' ? String(s.nama || '').trim() : String(s || '').trim(),
          target: kelas + (qismu ? ' - ' + qismu : ''),
          raw: s
        };
      }).filter(x => x.nama);
    }
    if (type === 'musyrif') {
      const list = (cd.musyrifs && cd.musyrifs.length) ? cd.musyrifs : (md.musyrifs || []);
      return list.map(m => ({
        type: 'musyrif',
        nama: typeof m === 'object' ? String(m.nama || '').trim() : String(m || '').trim(),
        target: 'Data Musyrif',
        raw: m
      })).filter(x => x.nama);
    }
    if (type === 'pengajar') {
      const list = (cd.pengajars && cd.pengajars.length) ? cd.pengajars : (md.pengajars || []);
      return list.map(p => ({
        type: 'pengajar',
        nama: typeof p === 'object' ? String(p.nama || '').trim() : String(p || '').trim(),
        target: 'Data Pengajar',
        raw: p
      })).filter(x => x.nama);
    }
    return [];
  }

  function findMemberByCode(rawCode, preferredType, extraNdef) {
    const cleanInput = normCode(rawCode);
    const rawUpper = normRawCode(rawCode);
    const ndefClean = extraNdef ? normCode(extraNdef) : '';
    const ndefRaw = extraNdef ? normRawCode(extraNdef) : '';
    if (!cleanInput && !ndefClean) return null;

    syncServerCoreDataToRegistry();

    const matchesIdentity = (idObj) => {
      const nfcC = normCode(idObj.nfcCode);
      const nfcR = normRawCode(idObj.nfcCode);
      const qrC = normCode(idObj.qrCode);
      const qrR = normRawCode(idObj.qrCode);

      if (nfcC && (nfcC === cleanInput || (ndefClean && nfcC === ndefClean) || nfcR === rawUpper || (ndefRaw && nfcR === ndefRaw))) {
        return true;
      }
      if (qrC && (qrC === cleanInput || (ndefClean && qrC === ndefClean) || qrR === rawUpper || (ndefRaw && qrR === ndefRaw))) {
        return true;
      }
      return false;
    };

    const typesOrder = [];
    if (preferredType) typesOrder.push(preferredType);
    ['wb', 'takhassus', 'musyrif', 'pengajar'].forEach(t => {
      if (typesOrder.indexOf(t) === -1) typesOrder.push(t);
    });

    for (let i = 0; i < typesOrder.length; i++) {
      const t = typesOrder[i];
      const members = getAllMembersForType(t);
      for (let j = 0; j < members.length; j++) {
        const m = members[j];
        const idObj = getIdentity(t, m.nama, typeof m.raw === 'object' ? m.raw : null);
        if (matchesIdentity(idObj)) {
          if ((preferredType === 'wb' || preferredType === 'takhassus') && t !== preferredType && (t === 'wb' || t === 'takhassus')) {
            const counterpartList = getAllMembersForType(preferredType);
            const sameStudent = counterpartList.find(x => normText(x.nama) === normText(m.nama));
            if (sameStudent) {
              const cId = getIdentity(preferredType, sameStudent.nama, typeof sameStudent.raw === 'object' ? sameStudent.raw : null);
              return {
                type: preferredType,
                nama: sameStudent.nama,
                target: sameStudent.target,
                nfcCode: cId.nfcCode || idObj.nfcCode,
                qrCode: cId.qrCode || idObj.qrCode
              };
            }
          }
          return {
            type: t,
            nama: m.nama,
            target: m.target,
            nfcCode: idObj.nfcCode,
            qrCode: idObj.qrCode
          };
        }
      }
    }

    return null;
  }

  // ===================== 2. STATUS TERVERIFIKASI HARI INI =====================
  function loadVerifiedToday() {
    try {
      const raw = localStorage.getItem(VERIFIED_TODAY_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      const today = getTodayDateStr();
      const cleaned = {};
      Object.keys(parsed || {}).forEach(k => {
        if (k.indexOf(today + '|') === 0) cleaned[k] = parsed[k];
      });
      return cleaned;
    } catch (e) {
      return {};
    }
  }

  function saveVerifiedToday(map) {
    try {
      localStorage.setItem(VERIFIED_TODAY_KEY, JSON.stringify(map || {}));
    } catch (e) {}
  }

  function verifiedKey(tglSesi, type, target, nama) {
    return [tglSesi || getTodayDateStr(), type, String(target || '').trim(), normText(nama)].join('|');
  }

  function getVerifiedRecord(tglSesi, type, target, nama) {
    const map = loadVerifiedToday();
    return map[verifiedKey(tglSesi, type, target, nama)] || null;
  }

  function setVerifiedRecord(tglSesi, type, target, nama, rec) {
    const map = loadVerifiedToday();
    map[verifiedKey(tglSesi, type, target, nama)] = rec;
    saveVerifiedToday(map);
  }

  // ===================== 3. STATUS & KUNCI NFC ANDROID NATIVE =====================
  function refreshNfcStatusFromNative() {
    try {
      if (global.AndroidBridge && typeof global.AndroidBridge.getNfcStatus === 'function') {
        const raw = global.AndroidBridge.getNfcStatus();
        if (raw) nfcStatusState = JSON.parse(raw);
      }
    } catch (e) {}
    renderNfcStatusBadges();
  }

  function syncNfcLockForCurrentContext() {
    const isAttendanceNfcTab = activeTabName === 'wb' || activeTabName === 'takhassus';
    const shouldLock = Boolean(nfcBindListening || isAttendanceNfcTab);
    const mode = nfcBindListening
      ? 'bind_db'
      : (activeTabName === 'wb' ? 'attendance_wb' : (activeTabName === 'takhassus' ? 'attendance_takhassus' : 'idle'));

    try {
      if (global.AndroidBridge && typeof global.AndroidBridge.setNfcLockMode === 'function') {
        global.AndroidBridge.setNfcLockMode(shouldLock, mode);
      }
    } catch (e) {}

    nfcStatusState.locked = shouldLock && nfcStatusState.enabled;
    nfcStatusState.mode = mode;
    renderNfcStatusBadges();
  }

  function renderNfcStatusBadges() {
    ['wb', 'takhassus'].forEach(t => {
      const badge = document.getElementById(t + 'NfcStatusBadge');
      const btnSettings = document.getElementById(t + 'BtnNfcSettings');
      if (!badge) return;

      if (!global.AndroidBridge) {
        badge.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300';
        badge.innerHTML = '<i class="fa-solid fa-wifi rotate-90 text-[10px]"></i><span>NFC: Khusus Aplikasi APK Android</span>';
        if (btnSettings) btnSettings.classList.add('hidden');
        return;
      }

      if (!nfcStatusState.supported) {
        badge.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-slate-100 dark:bg-slate-800 text-slate-500';
        badge.innerHTML = '<i class="fa-solid fa-circle-info text-[10px]"></i><span>HP tanpa sensor NFC (Gunakan QR)</span>';
        if (btnSettings) btnSettings.classList.add('hidden');
      } else if (!nfcStatusState.enabled) {
        badge.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold bg-amber-100 dark:bg-amber-950/70 text-amber-800 dark:text-amber-300';
        badge.innerHTML = '<i class="fa-solid fa-triangle-exclamation text-[10px]"></i><span>NFC HP Mati</span>';
        if (btnSettings) btnSettings.classList.remove('hidden');
      } else {
        badge.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold bg-emerald-100 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-300';
        badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span><span>NFC Terkunci ke Aplikasi • Siap Tap Kartu</span>';
        if (btnSettings) btnSettings.classList.add('hidden');
      }
    });

    const bindBox = document.getElementById('dbNfcListenBanner');
    if (bindBox) bindBox.classList.toggle('hidden', !nfcBindListening);
  }

  function openAndroidNfcSettings() {
    try {
      if (global.AndroidBridge && typeof global.AndroidBridge.openNfcSettings === 'function') {
        global.AndroidBridge.openNfcSettings();
      }
    } catch (e) {}
  }

  global.__androidOnNfcStatusChanged = function (statusJson) {
    try {
      nfcStatusState = typeof statusJson === 'string' ? JSON.parse(statusJson) : statusJson;
    } catch (e) {}
    renderNfcStatusBadges();
  };

  global.__androidOnNfcScanned = function (payloadJson) {
    try {
      const data = typeof payloadJson === 'string' ? JSON.parse(payloadJson) : payloadJson;
      if (!data) return;
      const code = String(data.uid || data.code || data.ndef || '').trim().toUpperCase();
      const ndef = String(data.ndef || '').trim();
      if (!code) return;

      if (nfcBindListening) {
        const nfcInput = document.getElementById('dbNfcCode');
        if (nfcInput) {
          nfcInput.value = code;
          nfcInput.classList.add('ring-2', 'ring-emerald-500');
          setTimeout(() => nfcInput.classList.remove('ring-2', 'ring-emerald-500'), 1400);
        }
        nfcBindListening = false;
        syncNfcLockForCurrentContext();
        showScanBanner('db', 'success', 'Kartu NFC Terbaca: ' + code + (ndef ? ' (NDEF: ' + ndef + ')' : ''));
        if (typeof global.Swal !== 'undefined') {
          global.Swal.fire({
            toast: true,
            position: 'top',
            icon: 'success',
            title: 'Kartu NFC berhasil ditautkan: ' + code,
            showConfirmButton: false,
            timer: 2200
          });
        }
        return;
      }

      const preferred = (activeTabName === 'wb' || activeTabName === 'takhassus') ? activeTabName : 'wb';
      handleSmartAttendanceScan(code, 'NFC', preferred, ndef);
    } catch (err) {
      console.warn('__androidOnNfcScanned error:', err);
    }
  };

  // ===================== 4. RENDER TABEL ABSENSI (BERSIH & OTOMATIS TERCENTANG) =====================
  function getActiveTargetForType(type) {
    if (type === 'wb') return (document.getElementById('wbRoomSelect')?.value || '').trim();
    if (type === 'takhassus') return (document.getElementById('takhClassSelect')?.value || '').trim();
    if (type === 'musyrif') return 'Data Musyrif';
    if (type === 'pengajar') return 'Data Pengajar';
    return '';
  }

  function getActiveDateForType(type) {
    const id = type === 'takhassus' ? 'takhDate' : (type + 'Date');
    return (document.getElementById(id)?.value || getTodayDateStr()).trim();
  }

  function renderAttendanceRowHtml(type, nama, index, idObj, verifiedRec) {
    const status = verifiedRec ? (verifiedRec.status || 'Hadir') : '';
    const isHadir = status === 'Hadir';
    const isIzin = status === 'Izin';
    const isAlpa = status === 'Alpa';
    const isDone = isHadir || isIzin || isAlpa;

    const pelArr = isDone && Array.isArray(verifiedRec.pelanggaran) ? verifiedRec.pelanggaran : [];
    const safeNama = escAttr(nama);
    const safeNfc = escAttr(idObj.nfcCode || '');
    const safeQr = escAttr(idObj.qrCode || '');
    const pelJsonAttr = escAttr(JSON.stringify(pelArr));

    const badgeMini = [];
    if (idObj.nfcCode && (type === 'wb' || type === 'takhassus')) {
      badgeMini.push('<span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950/70 text-indigo-600 dark:text-indigo-300 text-[9px] font-bold"><i class="fa-solid fa-wifi rotate-90 text-[8px]"></i>NFC</span>');
    }
    if (idObj.qrCode) {
      badgeMini.push('<span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-300 text-[9px] font-bold"><i class="fa-solid fa-qrcode text-[8px]"></i>QR</span>');
    }
    if (pelArr.length > 0) {
      badgeMini.push('<span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/60 text-amber-800 dark:text-amber-300 text-[9px] font-bold"><i class="fa-solid fa-triangle-exclamation text-[8px]"></i>' + escAttr(pelArr.join(', ')) + '</span>');
    }

    let statusCellHtml = '';
    let rowBg = 'hover:bg-slate-50 dark:hover:bg-slate-800/50';

    if (isHadir) {
      rowBg = 'bg-emerald-50/75 dark:bg-emerald-950/25';
      statusCellHtml = `<div class="flex items-center justify-end gap-2">
        <div class="inline-flex flex-col items-end gap-0.5">
          <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-emerald-100 dark:bg-emerald-900/70 text-emerald-700 dark:text-emerald-300 border border-emerald-300/60 dark:border-emerald-700">
            <i class="fa-solid fa-circle-check text-emerald-600 dark:text-emerald-400"></i>
            <span>Hadir • ${escAttr(verifiedRec.method || 'QR')}</span>
          </span>
          <span class="text-[9px] font-semibold text-emerald-600 dark:text-emerald-400">Otomatis tersimpan • ${escAttr(verifiedRec.waktuScan || '')}</span>
        </div>
        <button type="button" onclick="openPelanggaranModal('${type}', this)" title="Edit Pelanggaran" class="pel-trigger-btn w-8 h-8 rounded-xl inline-flex items-center justify-center ${pelArr.length > 0 ? 'bg-amber-100 dark:bg-amber-900/70 text-amber-700 dark:text-amber-300 border border-amber-300/70' : 'bg-white dark:bg-slate-800 text-slate-400 hover:text-amber-600 border border-slate-200 dark:border-slate-700'}">
          <i class="fa-solid fa-triangle-exclamation text-[11px]"></i>
          <span class="pel-btn-label hidden">${pelArr.length > 0 ? ('Pelanggaran (' + pelArr.length + ')') : 'Pelanggaran'}</span>
        </button>
      </div>`;
    } else if (isIzin) {
      rowBg = 'bg-amber-50/60 dark:bg-amber-950/20';
      statusCellHtml = `<div class="inline-flex flex-col items-end gap-0.5">
        <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-amber-100 dark:bg-amber-900/70 text-amber-800 dark:text-amber-300 border border-amber-300/60">
          <i class="fa-solid fa-envelope-open-text text-[10px]"></i>
          <span>Izin</span>
        </span>
        <span class="text-[9px] font-semibold text-amber-700 dark:text-amber-400">Tersimpan • ${escAttr(verifiedRec.waktuScan || '')}</span>
      </div>`;
    } else if (isAlpa) {
      rowBg = 'bg-red-50/60 dark:bg-red-950/20';
      statusCellHtml = `<div class="inline-flex flex-col items-end gap-0.5">
        <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-red-100 dark:bg-red-900/70 text-red-700 dark:text-red-300 border border-red-300/60">
          <i class="fa-solid fa-circle-xmark text-[10px]"></i>
          <span>Alpa</span>
        </span>
        <span class="text-[9px] font-semibold text-red-600 dark:text-red-400">Tersimpan • ${escAttr(verifiedRec.waktuScan || '')}</span>
      </div>`;
    } else {
      statusCellHtml = `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 border border-slate-200/80 dark:border-slate-700">
        <span class="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
        <span>Belum Verifikasi</span>
      </span>`;
    }

    const approvedIzin = (!isDone && (type === 'musyrif' || type === 'pengajar') && global.AlRifaieSmart && typeof global.AlRifaieSmart.getApprovedIzinForStaff === 'function')
      ? global.AlRifaieSmart.getApprovedIzinForStaff(nama, getActiveDateForType(type))
      : null;

    if (!isDone && approvedIzin) {
      rowBg = 'bg-amber-50/70 dark:bg-amber-950/25';
      statusCellHtml = `<div class="inline-flex flex-col items-end gap-0.5">
        <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-amber-100 dark:bg-amber-900/70 text-amber-800 dark:text-amber-200 border border-amber-300/70">
          <i class="fa-solid fa-file-circle-check text-[10px]"></i>
          <span>Izin Digital • ${escAttr(approvedIzin.jenis || 'Izin')}</span>
        </span>
        <span class="text-[9px] font-semibold text-amber-700 dark:text-amber-400">Disetujui Admin • Otomatis Izin</span>
      </div>`;
    }

    return `<tr data-nama="${safeNama}" data-nfc="${safeNfc}" data-qr="${safeQr}" data-verified="${isDone ? '1' : '0'}" data-status="${escAttr(status || (approvedIzin ? 'Izin Digital' : 'Belum Verifikasi'))}" data-izin-digital="${approvedIzin ? '1' : '0'}" data-izin-jenis="${approvedIzin ? escAttr(approvedIzin.jenis || 'Izin') : ''}" data-method="${escAttr(isDone ? (verifiedRec.method || 'QR') : '')}" data-pelanggaran="${pelJsonAttr}" class="${rowBg} transition-colors">
      <td class="p-3 align-middle">
        <div class="flex items-center gap-2">
          ${isHadir
            ? '<span class="w-5 h-5 rounded-full bg-emerald-500 text-white inline-flex items-center justify-center shrink-0 text-[10px]"><i class="fa-solid fa-check"></i></span>'
            : (isIzin || approvedIzin
              ? '<span class="w-5 h-5 rounded-full bg-amber-500 text-white inline-flex items-center justify-center shrink-0 text-[10px]"><i class="fa-solid fa-i"></i></span>'
              : (isAlpa
                ? '<span class="w-5 h-5 rounded-full bg-red-500 text-white inline-flex items-center justify-center shrink-0 text-[10px]"><i class="fa-solid fa-xmark"></i></span>'
                : '<span class="w-5 h-5 rounded-full border-2 border-slate-300 dark:border-slate-600 inline-flex items-center justify-center shrink-0 text-[9px] font-bold text-slate-400">' + (index + 1) + '</span>'))}
          <div class="min-w-0">
            <div class="font-semibold text-slate-800 dark:text-slate-100 leading-snug">${escAttr(nama)}</div>
            ${badgeMini.length ? '<div class="flex flex-wrap items-center gap-1 mt-1">' + badgeMini.join('') + '</div>' : ''}
          </div>
        </div>
      </td>
      <td class="p-3 text-right align-middle whitespace-nowrap">${statusCellHtml}</td>
    </tr>`;
  }

  function updateAttendanceSummaryUI(type) {
    const tbody = document.getElementById(type + 'TableBody');
    const counterEl = document.getElementById(type + 'ScanCounter');
    const submitBtnIdMap = { wb: 'btnSubmitWb', takhassus: 'btnSubmitTakh', musyrif: 'btnSubmitMus', pengajar: 'btnSubmitPen' };
    const btn = document.getElementById(submitBtnIdMap[type]);
    if (!tbody) return;

    const rows = Array.from(tbody.querySelectorAll('tr[data-nama]'));
    const total = rows.length;
    const hadirCount = rows.filter(r => r.dataset.status === 'Hadir').length;
    const unverifiedCount = rows.filter(r => r.dataset.verified !== '1').length;

    if (counterEl) {
      counterEl.innerHTML = `<span class="font-extrabold text-emerald-600 dark:text-emerald-400">${hadirCount}</span> / ${total} Hadir`;
    }
    if (btn) {
      if (total === 0) {
        btn.className = 'px-3.5 py-2 bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs rounded-xl transition-colors whitespace-nowrap inline-flex items-center gap-1.5';
        btn.innerHTML = '<i class="fa-solid fa-user-clock"></i><span>Input Izin / Alpa</span>';
      } else if (unverifiedCount === 0) {
        btn.className = 'px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-xl transition-colors whitespace-nowrap inline-flex items-center gap-1.5';
        btn.innerHTML = '<i class="fa-solid fa-circle-check"></i><span>Semua Terverifikasi</span>';
      } else {
        btn.className = 'px-3.5 py-2 bg-amber-600 hover:bg-amber-700 active:scale-95 text-white font-bold text-xs rounded-xl transition-all whitespace-nowrap inline-flex items-center gap-1.5 shadow-sm';
        btn.innerHTML = '<i class="fa-solid fa-user-clock"></i><span>Input Izin / Alpa (' + unverifiedCount + ')</span>';
      }
    }
  }

  function loadMembersEnhanced(type) {
    syncServerCoreDataToRegistry();
    let target = '';
    let tbody = null;
    let arr = [];

    if (type === 'wb') {
      target = (document.getElementById('wbRoomSelect')?.value || '').trim();
      tbody = document.getElementById('wbTableBody');
      if (!target) {
        if (tbody) tbody.innerHTML = '<tr><td colspan="2" class="p-6 text-center text-slate-400">Silakan pilih kamar terlebih dahulu.</td></tr>';
        updateAttendanceSummaryUI(type);
        return;
      }
      arr = (global.coreData?.santriWB || []).filter(s => String(s.kamar || '').trim() === target);
    } else if (type === 'takhassus') {
      target = (document.getElementById('takhClassSelect')?.value || '').trim();
      tbody = document.getElementById('takhassusTableBody');
      if (!target) {
        if (tbody) tbody.innerHTML = '<tr><td colspan="2" class="p-6 text-center text-slate-400">Silakan pilih kelas &amp; qismu terlebih dahulu.</td></tr>';
        updateAttendanceSummaryUI(type);
        return;
      }
      arr = (global.coreData?.santriTakhassus || []).filter(s => (String(s.kelas || '').trim() + (s.qismu ? ' - ' + String(s.qismu).trim() : '')) === target);
    } else if (type === 'musyrif') {
      target = 'Data Musyrif';
      tbody = document.getElementById('musyrifTableBody');
      arr = (global.coreData?.musyrifs && global.coreData.musyrifs.length) ? global.coreData.musyrifs : (global.masterData?.musyrifs || []);
    } else if (type === 'pengajar') {
      target = 'Data Pengajar';
      tbody = document.getElementById('pengajarTableBody');
      arr = (global.coreData?.pengajars && global.coreData.pengajars.length) ? global.coreData.pengajars : (global.masterData?.pengajars || []);
    }

    if (!tbody) return;
    if (!arr.length) {
      tbody.innerHTML = `<tr><td colspan="2" class="p-6 text-center text-slate-400">${global.isCoreLoaded ? 'Tidak ada data anggota pada pilihan ini.' : '<i class="fa-solid fa-spinner fa-spin mr-1.5"></i>Sedang menyinkronkan daftar nama...'}</td></tr>`;
      updateAttendanceSummaryUI(type);
      return;
    }

    const tglSesi = getActiveDateForType(type);
    tbody.innerHTML = arr.map((m, i) => {
      const nama = typeof m === 'object' ? String(m.nama || '').trim() : String(m || '').trim();
      const idObj = getIdentity(type, nama, typeof m === 'object' ? m : null);
      const verifiedRec = getVerifiedRecord(tglSesi, type, target, nama);
      return renderAttendanceRowHtml(type, nama, i, idObj, verifiedRec);
    }).join('');

    updateAttendanceSummaryUI(type);
  }

  function showScanBanner(scopeType, variant, message) {
    // Tampilkan notifikasi melayang (floating pill) di tepi atas layar dengan pointer-events-none
    // agar TIDAK memotong / menutupi layar scan kamera maupun menyulitkan petugas saat antre scan!
    let toast = document.getElementById('scanFloatingToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'scanFloatingToast';
      toast.className = 'fixed top-3 left-1/2 -translate-x-1/2 z-[165] pointer-events-none w-[calc(100%-24px)] max-w-sm transition-all duration-200 opacity-0 -translate-y-2';
      document.body.appendChild(toast);
    }

    const pillStyles = {
      success: 'bg-emerald-600/95 text-white border-emerald-400/60',
      info: 'bg-indigo-600/95 text-white border-indigo-400/60',
      warn: 'bg-amber-600/95 text-white border-amber-400/60'
    };
    const iconCls = variant === 'success'
      ? 'fa-circle-check'
      : (variant === 'warn' ? 'fa-triangle-exclamation' : 'fa-circle-info');

    toast.innerHTML = `<div class="px-3.5 py-2.5 rounded-2xl border shadow-xl backdrop-blur-md text-xs font-bold flex items-center gap-2 ${pillStyles[variant] || pillStyles.info}">
      <i class="fa-solid ${iconCls} shrink-0 text-sm"></i>
      <span class="leading-snug">${escAttr(message)}</span>
    </div>`;

    toast.classList.remove('opacity-0', '-translate-y-2');
    toast.classList.add('opacity-100', 'translate-y-0');

    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => {
      toast.classList.remove('opacity-100', 'translate-y-0');
      toast.classList.add('opacity-0', '-translate-y-2');
    }, 2400);

    // Pastikan banner lama di dalam kartu & layar kamera tetap tersembunyi agar tidak menggeser/memotong tampilan scan
    const inlineEl = document.getElementById(scopeType + 'ScanFeedback');
    if (inlineEl) inlineEl.classList.add('hidden');
    const modalFeedback = document.getElementById('qrModalFeedback');
    if (modalFeedback) modalFeedback.classList.add('hidden');
  }

  // ===================== 5. POPUP SCAN NFC/QR -> PILIH PELANGGARAN -> AUTO SIMPAN =====================
  function readSelectedScanConfirmPelanggaran(type) {
    const pel = [];
    const isSantri = type === 'wb' || type === 'takhassus';
    if (isSantri) {
      document.querySelectorAll('input[name="scanConfirmPelSantri"]:checked').forEach(chk => pel.push(chk.value));
    } else {
      const cek = document.getElementById('scanConfirmCekTelat');
      const inp = document.getElementById('scanConfirmMenitTelat');
      if (cek && cek.checked) {
        const mnt = inp && inp.value ? inp.value.trim() : '';
        pel.push(mnt ? ('Terlambat ' + mnt + ' Menit') : 'Terlambat');
      }
    }
    return pel;
  }

  function normalizeScopeToken(str) {
    return normText(str).replace(/^(kamar|kmr\.?|kelas|kls\.?)\s+/i, '').trim();
  }

  function targetMatchesAssignedScope(rawTarget, allowedTargets) {
    if (!rawTarget || !Array.isArray(allowedTargets) || !allowedTargets.length) return false;
    const rtNorm = normText(rawTarget);
    const rtTok = normalizeScopeToken(rawTarget);
    return allowedTargets.some(a => {
      const aNorm = normText(a);
      const aTok = normalizeScopeToken(a);
      if (!aNorm) return false;
      return rtNorm === aNorm || (rtTok && aTok && rtTok === aTok);
    });
  }

  function getLoggedInScanScope(scanType) {
    const sess = global.session;
    if (!sess || sess.role === 'admin') return null;

    const cd = global.coreData || {};
    const md = global.masterData || {};
    const nameNorm = normText(sess.name);

    if (sess.role === 'musyrif') {
      const roomsMap = new Map();
      const addRooms = (raw) => {
        String(raw || '').split(/[,;\n]+/).forEach(part => {
          const clean = part.trim();
          if (!clean) return;
          const tok = normalizeScopeToken(clean);
          if (tok && !roomsMap.has(tok)) roomsMap.set(tok, clean);
        });
      };
      if (sess.kamar) addRooms(sess.kamar);
      (md.musyrifs || []).concat(cd.musyrifs || [])
        .filter(m => m && normText(m.nama) === nameNorm)
        .forEach(m => addRooms(m.kamar || m.f2));

      const targets = Array.from(roomsMap.values());
      return {
        role: 'musyrif',
        allowedType: 'wb',
        targets: targets,
        label: targets.length ? targets.join(', ') : 'Belum tertaut'
      };
    }

    if (sess.role === 'pengajar' && scanType === 'takhassus') {
      const clsMap = new Map();
      const addClasses = (kRaw, qRaw) => {
        const kArr = String(kRaw || '').split(/[,;\n]+/).map(x => x.trim()).filter(Boolean);
        const qArr = String(qRaw || '').split(/[,;\n]+/).map(x => x.trim()).filter(Boolean);
        kArr.forEach((k, i) => {
          const q = qArr[i] || qArr[0] || '';
          const full = q ? `${k} - ${q}` : k;
          const tok = normalizeScopeToken(full);
          if (tok && !clsMap.has(tok)) clsMap.set(tok, full);
        });
      };
      if (sess.kelas) addClasses(sess.kelas, sess.qismu);
      (md.pengajars || []).concat(cd.pengajars || [])
        .filter(p => p && normText(p.nama) === nameNorm)
        .forEach(p => addClasses(p.kelas || p.f2, p.qismu || p.f3));

      const targets = Array.from(clsMap.values());
      return {
        role: 'pengajar',
        allowedType: 'takhassus',
        targets: targets,
        label: targets.length ? targets.join(', ') : 'Belum tertaut'
      };
    }

    return null;
  }

  function updateScanConfirmButtonLabel() {
    if (!pendingScanConfirm) return;
    const btn = document.getElementById('scanConfirmSaveBtn');
    if (!btn) return;
    const pel = readSelectedScanConfirmPelanggaran(pendingScanConfirm.match.type);
    const isUpdate = Boolean(pendingScanConfirm.isUpdateExisting);
    if (pel.length > 0) {
      btn.className = 'flex-1 py-3 px-4 min-h-[46px] rounded-2xl bg-amber-600 hover:bg-amber-700 active:scale-[0.98] text-white font-bold text-xs inline-flex items-center justify-center gap-2 shadow-md transition-all';
      btn.innerHTML = isUpdate
        ? '<i class="fa-solid fa-circle-check"></i><span>Perbarui + ' + pel.length + ' Pelanggaran</span>'
        : '<i class="fa-solid fa-circle-check"></i><span>Simpan + ' + pel.length + ' Pelanggaran</span>';
    } else {
      btn.className = 'flex-1 py-3 px-4 min-h-[46px] rounded-2xl bg-emerald-600 hover:bg-emerald-700 active:scale-[0.98] text-white font-bold text-xs inline-flex items-center justify-center gap-2 shadow-md transition-all';
      btn.innerHTML = isUpdate
        ? '<i class="fa-solid fa-circle-check"></i><span>Simpan Tanpa Pelanggaran</span>'
        : '<i class="fa-solid fa-circle-check"></i><span>Hadir &amp; Simpan</span>';
    }
  }

  function openScanConfirmPopup(match, source, preferredType, rawCode, existingRecord) {
    // Jika masih ada kartu orang LAIN yang belum sempat diklik (antrean scan QR/NFC beruntun),
    // otomatis langsung simpan yang sebelumnya agar antrean lancar tanpa hambatan!
    if (pendingScanConfirm) {
      commitScanConfirmToDatabase(true);
    }

    const isUpdateExisting = Boolean(existingRecord && (existingRecord.status || 'Hadir') === 'Hadir');

    // Evaluasi batas waktu absen dari Setelan Admin (otomatis tercatat Terlambat jika melewati jam batas)
    const lateInfo = (!isUpdateExisting && global.AlRifaieAdminSettings && typeof global.AlRifaieAdminSettings.evaluateDeadline === 'function')
      ? global.AlRifaieAdminSettings.evaluateDeadline(match.type)
      : { enabled: false, isLate: false, diffMinutes: 0, deadlineTime: '' };

    pendingScanConfirm = {
      match: match,
      source: source,
      preferredType: preferredType,
      rawCode: rawCode,
      lateInfo: lateInfo,
      isUpdateExisting: isUpdateExisting,
      existingRecord: existingRecord || null
    };

    // Jeda singkat 1200ms agar kartu berbeda di antrean tetap cepat terbaca,
    // sementara kartu orang yang SAMA dijaga tidak memicu auto-simpan saat petugas sedang memilih pelanggaran.
    qrScanPausedForConfirm = true;
    if (qrPauseTimer) clearTimeout(qrPauseTimer);
    qrPauseTimer = setTimeout(() => {
      qrScanPausedForConfirm = false;
      qrPauseTimer = null;
    }, 1200);

    const nameEl = document.getElementById('scanConfirmName');
    const subEl = document.getElementById('scanConfirmSub');
    const badgeEl = document.getElementById('scanConfirmMethodBadge');
    const iconBoxEl = document.getElementById('scanConfirmIconBox');
    const lateBadgeEl = document.getElementById('scanConfirmLateBadge');
    const boxSantri = document.getElementById('scanConfirmPelSantri');
    const boxPetugas = document.getElementById('scanConfirmPelPetugas');

    if (iconBoxEl) {
      iconBoxEl.className = source === 'NFC'
        ? 'w-11 h-11 rounded-2xl bg-gradient-to-br from-indigo-500 to-blue-600 text-white flex items-center justify-center shrink-0 shadow-sm text-base'
        : 'w-11 h-11 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white flex items-center justify-center shrink-0 shadow-sm text-base';
      iconBoxEl.innerHTML = source === 'NFC'
        ? '<i class="fa-solid fa-wifi rotate-90"></i>'
        : '<i class="fa-solid fa-qrcode"></i>';
    }
    if (nameEl) nameEl.innerText = match.nama;
    if (subEl) {
      const waktuLabel = isUpdateExisting && existingRecord && existingRecord.waktuScan
        ? ('Hadir ' + existingRecord.waktuScan)
        : getWibTimeStr();
      subEl.innerText = (match.target || match.type.toUpperCase()) + ' • ' + waktuLabel;
    }
    if (badgeEl) {
      badgeEl.innerHTML = isUpdateExisting
        ? `<i class="fa-solid ${source === 'NFC' ? 'fa-wifi rotate-90' : 'fa-qrcode'}"></i><span>${source} • Edit Pelanggaran</span>`
        : `<i class="fa-solid ${source === 'NFC' ? 'fa-wifi rotate-90' : 'fa-qrcode'}"></i><span>${source} Terdeteksi</span>`;
    }

    if (lateBadgeEl) {
      if (lateInfo && lateInfo.isLate) {
        lateBadgeEl.classList.remove('hidden');
        lateBadgeEl.innerHTML = `<i class="fa-solid fa-clock"></i><span>Terlambat +${lateInfo.diffMinutes}m (Batas ${escAttr(lateInfo.deadlineTime)})</span>`;
      } else {
        lateBadgeEl.classList.add('hidden');
      }
    }

    const isSantri = match.type === 'wb' || match.type === 'takhassus';
    if (boxSantri) boxSantri.classList.toggle('hidden', !isSantri);
    if (boxPetugas) boxPetugas.classList.toggle('hidden', isSantri);

    const existingPel = (isUpdateExisting && existingRecord && Array.isArray(existingRecord.pelanggaran))
      ? existingRecord.pelanggaran
      : [];

    // Reset seluruh pilihan pelanggaran lalu isi sesuai data lama (saat edit) atau auto-centang Terlambat jika lewat batas waktu
    document.querySelectorAll('input[name="scanConfirmPelSantri"]').forEach(chk => {
      if (isSantri && isUpdateExisting) {
        chk.checked = existingPel.includes(chk.value);
      } else {
        chk.checked = Boolean(isSantri && lateInfo && lateInfo.isLate && chk.value === 'Terlambat');
      }
    });
    const cekTelat = document.getElementById('scanConfirmCekTelat');
    const wrapTelat = document.getElementById('scanConfirmMenitWrap');
    const inpTelat = document.getElementById('scanConfirmMenitTelat');
    let petugasLateChecked = false;
    let petugasLateMinutes = '';
    if (!isSantri && isUpdateExisting) {
      const telatEntry = existingPel.find(p => String(p || '').toLowerCase().includes('terlambat'));
      if (telatEntry) {
        petugasLateChecked = true;
        const mMatch = String(telatEntry).match(/\d+/);
        petugasLateMinutes = mMatch ? mMatch[0] : '';
      }
    } else if (!isSantri && lateInfo && lateInfo.isLate) {
      petugasLateChecked = true;
      petugasLateMinutes = String(lateInfo.diffMinutes || 1);
    }
    if (cekTelat) cekTelat.checked = petugasLateChecked;
    if (wrapTelat) wrapTelat.classList.toggle('hidden', !petugasLateChecked);
    if (inpTelat) inpTelat.value = petugasLateMinutes;

    updateScanConfirmButtonLabel();

    const modalEl = document.getElementById('scanConfirmModal');
    if (modalEl) {
      modalEl.classList.remove('hidden');
      modalEl.classList.add('modal-is-open');
    }
  }

  function commitScanConfirmToDatabase(silentReopenNext) {
    if (!pendingScanConfirm) return;
    const { match, source, preferredType, rawCode, isUpdateExisting, existingRecord } = pendingScanConfirm;
    const selectedPel = readSelectedScanConfirmPelanggaran(match.type);
    pendingScanConfirm = null;

    lastHandledPersonKey = match.type + '|' + normText(match.nama);
    lastHandledPersonTime = Date.now();

    if (!silentReopenNext) {
      if (qrPauseTimer) {
        clearTimeout(qrPauseTimer);
        qrPauseTimer = null;
      }
      const modalEl = document.getElementById('scanConfirmModal');
      if (modalEl) {
        modalEl.classList.add('hidden');
        modalEl.classList.remove('modal-is-open');
      }
      qrScanPausedForConfirm = false;
    }

    const tglSesi = getActiveDateForType(match.type);
    const waktuScan = (isUpdateExisting && existingRecord && existingRecord.waktuScan)
      ? existingRecord.waktuScan
      : getWibTimeStr();
    const verifiedRec = {
      status: 'Hadir',
      method: (isUpdateExisting && existingRecord && existingRecord.method) ? existingRecord.method : source,
      code: rawCode,
      nfcCode: source === 'NFC' ? (match.nfcCode || rawCode) : (match.nfcCode || (existingRecord && existingRecord.nfcCode) || ''),
      qrCode: source === 'QR' ? (match.qrCode || rawCode) : (match.qrCode || (existingRecord && existingRecord.qrCode) || ''),
      waktuScan: waktuScan,
      pelanggaran: selectedPel,
      synced: true
    };

    setVerifiedRecord(tglSesi, match.type, match.target, match.nama, verifiedRec);

    // Update baris nama di form absensi secara instan menjadi tercentang Hadir
    const activeTargetNow = getActiveTargetForType(match.type);
    const currentRow = findRowInDom(match.type, match.target, match.nama);
    if (currentRow && activeTargetNow === match.target) {
      const idx = Array.from(currentRow.parentNode.children).indexOf(currentRow);
      const idObj = getIdentity(match.type, match.nama, null);
      const temp = document.createElement('tbody');
      temp.innerHTML = renderAttendanceRowHtml(match.type, match.nama, idx, idObj, verifiedRec);
      const newRow = temp.firstElementChild;
      if (newRow) {
        currentRow.replaceWith(newRow);
        newRow.classList.add('ring-2', 'ring-emerald-400');
        setTimeout(() => newRow.classList.remove('ring-2', 'ring-emerald-400'), 1400);
        try { newRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) {}
      }
      updateAttendanceSummaryUI(match.type);
    }

    // Otomatis kirim & simpan ke database (Google Sheet / Offline Sync Queue) — tanpa tombol simpan ulang!
    const sess = global.session || { role: 'user', name: 'Petugas' };
    const payload = {
      type: match.type,
      role: sess.role || 'user',
      petugas: sess.name || 'Petugas',
      target: match.target,
      tglSesi: tglSesi,
      isSingleScanUpdate: true,
      items: [{
        nama: match.nama,
        kehadiran: 'Hadir',
        pelanggaran: selectedPel,
        nfcCode: verifiedRec.nfcCode,
        qrCode: verifiedRec.qrCode,
        metodeAbsen: verifiedRec.method,
        waktuScan: waktuScan,
        autoScan: true
      }]
    };

    try {
      global.google.script.run
        .withSuccessHandler(() => {
          if (typeof global.rekCache !== 'undefined') global.rekCache = {};
          if (typeof global.missingCache !== 'undefined') global.missingCache = null;
          if (typeof global.markTargetSubmittedInMissingCache === 'function') {
            global.markTargetSubmittedInMissingCache(match.type, match.target, tglSesi);
          }
        })
        .withFailureHandler(err => {
          console.warn('Auto-save scan gagal:', err);
        })
        .submitAbsensi(payload);
    } catch (e) {
      console.warn('submitAbsensi auto-scan error:', e);
    }

    vibrateSafe(45);
    const sameRoom = activeTargetNow === match.target;
    const pelText = selectedPel.length ? (' • ' + selectedPel.join(', ')) : '';
    const msg = isUpdateExisting
      ? ('Pelanggaran ' + match.nama + ' diperbarui' + (selectedPel.length ? ': ' + selectedPel.join(', ') : ' (Tanpa Pelanggaran)'))
      : (sameRoom
        ? match.nama + ' Hadir (' + source + ')' + pelText
        : match.nama + ' Hadir → ' + match.target + ' (' + source + ')' + pelText);
    showScanBanner(preferredType, 'success', msg);
  }

  function cancelScanConfirmPopup() {
    if (pendingScanConfirm && pendingScanConfirm.match) {
      lastHandledPersonKey = pendingScanConfirm.match.type + '|' + normText(pendingScanConfirm.match.nama);
      lastHandledPersonTime = Date.now();
    }
    if (qrPauseTimer) {
      clearTimeout(qrPauseTimer);
      qrPauseTimer = null;
    }
    pendingScanConfirm = null;
    qrScanPausedForConfirm = false;
    const modalEl = document.getElementById('scanConfirmModal');
    if (modalEl) {
      modalEl.classList.add('hidden');
      modalEl.classList.remove('modal-is-open');
    }
  }

  function handleSmartAttendanceScan(rawCode, source, preferredType, extraNdef) {
    const match = findMemberByCode(rawCode, preferredType, extraNdef);
    if (!match) {
      vibrateSafe(110);
      showScanBanner(preferredType, 'warn', 'Kode ' + source + ' (' + rawCode + ') belum terdaftar di Manajemen Database.');
      return false;
    }

    if ((preferredType === 'musyrif' || preferredType === 'pengajar') && match.type !== preferredType) {
      vibrateSafe(110);
      showScanBanner(preferredType, 'warn', match.nama + ' terdaftar di kategori ' + match.type.toUpperCase() + ', bukan ' + preferredType.toUpperCase() + '.');
      return false;
    }

    // Filter ketat sesuai kamar Musyrif (atau kelas Pengajar) yang sedang login:
    // contoh: Musyrif kamar 106 & 102 tidak dapat memindai anggota kamar 103.
    const scope = getLoggedInScanScope(preferredType || match.type);
    if (scope) {
      if (!scope.targets.length) {
        vibrateSafe(130);
        showScanBanner(preferredType, 'warn', 'Akun Anda belum ditautkan ke ' + (scope.role === 'musyrif' ? 'kamar binaan' : 'kelas binaan') + '. Hubungi Admin.');
        return false;
      }
      if (match.type !== scope.allowedType || !targetMatchesAssignedScope(match.target, scope.targets)) {
        vibrateSafe(130);
        const unitLbl = scope.role === 'musyrif' ? 'kamar binaan' : 'kelas binaan';
        showScanBanner(
          preferredType,
          'warn',
          'Scan ditolak: ' + match.nama + ' (' + (match.target || '-') + ') bukan ' + unitLbl + ' Anda (' + scope.label + ').'
        );
        return false;
      }
    }

    const personKey = match.type + '|' + normText(match.nama);

    // Jika popup pilihan pelanggaran untuk ORANG YANG SAMA sedang terbuka, abaikan bacaan ulang kamera/NFC
    // agar popup tidak ter-reset atau otomatis tertutup saat petugas sedang memilih pelanggaran!
    if (
      pendingScanConfirm &&
      pendingScanConfirm.match &&
      (pendingScanConfirm.match.type + '|' + normText(pendingScanConfirm.match.nama)) === personKey
    ) {
      return true;
    }

    // Jeda anti-pantulan 3.5 detik khusus untuk kartu yang BARU SAJA disimpan/dibatalkan
    if (lastHandledPersonKey === personKey && (Date.now() - lastHandledPersonTime) < 3500) {
      return true;
    }

    const tglSesi = getActiveDateForType(match.type);
    const existing = getVerifiedRecord(tglSesi, match.type, match.target, match.nama);
    if (existing && (existing.status || 'Hadir') === 'Hadir') {
      vibrateSafe(40);
      openScanConfirmPopup(match, source, preferredType, rawCode, existing);
      return true;
    }

    vibrateSafe(55);
    openScanConfirmPopup(match, source, preferredType, rawCode, null);
    return true;
  }

  function findRowInDom(type, target, nama) {
    const activeTarget = getActiveTargetForType(type);
    if (activeTarget !== target) return null;
    const tbody = document.getElementById(type + 'TableBody');
    if (!tbody) return null;
    const targetNorm = normText(nama);
    const rows = tbody.querySelectorAll('tr[data-nama]');
    for (let i = 0; i < rows.length; i++) {
      if (normText(rows[i].dataset.nama) === targetNorm) return rows[i];
    }
    return null;
  }

  function onPelanggaranUpdated(tr, type, pelArr) {
    if (!tr || tr.dataset.status !== 'Hadir') return;
    const target = getActiveTargetForType(type);
    const tglSesi = getActiveDateForType(type);
    const nama = tr.dataset.nama || '';
    if (!target || !nama) return;

    const rec = getVerifiedRecord(tglSesi, type, target, nama) || {
      status: 'Hadir',
      method: tr.dataset.method || 'QR',
      nfcCode: tr.dataset.nfc || '',
      qrCode: tr.dataset.qr || '',
      waktuScan: getWibTimeStr()
    };
    rec.status = 'Hadir';
    rec.pelanggaran = Array.isArray(pelArr) ? pelArr : [];
    setVerifiedRecord(tglSesi, type, target, nama, rec);

    // Refresh baris agar chip pelanggaran tampil langsung di tabel
    loadMembersEnhanced(type);

    const sess = global.session || { role: 'user', name: 'Petugas' };
    try {
      global.google.script.run
        .withSuccessHandler(() => {
          showScanBanner(type, 'info', 'Pelanggaran untuk ' + nama + ' otomatis diperbarui di database.');
        })
        .withFailureHandler(() => {})
        .submitAbsensi({
          type: type,
          role: sess.role || 'user',
          petugas: sess.name || 'Petugas',
          target: target,
          tglSesi: tglSesi,
          isSingleScanUpdate: true,
          items: [{
            nama: nama,
            kehadiran: 'Hadir',
            pelanggaran: rec.pelanggaran,
            nfcCode: rec.nfcCode || tr.dataset.nfc || '',
            qrCode: rec.qrCode || tr.dataset.qr || '',
            metodeAbsen: rec.method || 'QR',
            waktuScan: rec.waktuScan || getWibTimeStr(),
            autoScan: true
          }]
        });
    } catch (e) {}
  }

  // ===================== 6. MODAL INPUT IZIN & ALPA (HANYA YANG BELUM TERVERIFIKASI) =====================
  function openIzinAlpaModal(type) {
    const target = getActiveTargetForType(type);
    const tglSesi = getActiveDateForType(type);
    const allRows = Array.from(document.querySelectorAll('#' + type + 'TableBody tr[data-nama]'));
    if (!target || !allRows.length) {
      return global.Swal.fire('Pilih Target Dulu', 'Silakan pilih kamar / kelas atau tunggu daftar nama termuat.', 'warning');
    }

    const unverifiedRows = allRows.filter(tr => tr.dataset.verified !== '1');
    if (unverifiedRows.length === 0) {
      return global.Swal.fire('Semua Sudah Terverifikasi', 'Seluruh nama pada daftar ini sudah tercatat Hadir / Izin / Alpa dan masuk ke database.', 'success');
    }

    activeIzinAlpaContext = {
      type: type,
      target: target,
      tglSesi: tglSesi,
      items: unverifiedRows.map(tr => {
        const hasIzinDigital = tr.dataset.izinDigital === '1';
        return {
          nama: tr.dataset.nama,
          nfcCode: tr.dataset.nfc || '',
          qrCode: tr.dataset.qr || '',
          izinDigitalJenis: tr.dataset.izinJenis || '',
          choice: hasIzinDigital ? 'Izin' : 'Alpa'
        };
      })
    };

    const titleEl = document.getElementById('izinAlpaModalTitle');
    const subEl = document.getElementById('izinAlpaModalSubtitle');
    if (titleEl) titleEl.innerText = 'Input Izin & Alpa • ' + target;
    if (subEl) subEl.innerText = 'Hanya menampilkan ' + unverifiedRows.length + ' nama yang belum terverifikasi hadir';

    renderIzinAlpaModalList();
    if (typeof global.openModal === 'function') {
      global.openModal('izinAlpaModal');
    } else {
      document.getElementById('izinAlpaModal')?.classList.remove('hidden');
    }
  }

  function renderIzinAlpaModalList() {
    if (!activeIzinAlpaContext) return;
    const container = document.getElementById('izinAlpaListContainer');
    const summaryEl = document.getElementById('izinAlpaSummaryText');
    const sendBtn = document.getElementById('btnSendIzinAlpa');
    if (!container) return;

    const items = activeIzinAlpaContext.items;
    container.innerHTML = items.map((it, idx) => {
      const btnStyle = (opt) => {
        if (it.choice === opt) {
          if (opt === 'Izin') return 'bg-amber-500 text-white border-amber-500 shadow-sm';
          if (opt === 'Alpa') return 'bg-red-600 text-white border-red-600 shadow-sm';
          return 'bg-slate-600 text-white border-slate-600 shadow-sm';
        }
        return 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-50';
      };

      const subNote = it.izinDigitalJenis
        ? `<div class="text-[10px] font-bold text-amber-600 dark:text-amber-400"><i class="fa-solid fa-file-circle-check mr-1"></i>Izin Digital Disetujui (${escAttr(it.izinDigitalJenis)})</div>`
        : '<div class="text-[10px] text-slate-400">Belum terverifikasi</div>';

      return `<div class="p-3 rounded-xl border ${it.izinDigitalJenis ? 'border-amber-300/80 dark:border-amber-800/70 bg-amber-50/50 dark:bg-amber-950/20' : 'border-slate-200/90 dark:border-slate-700/80 bg-slate-50/70 dark:bg-slate-900/40'} flex items-center justify-between gap-2">
        <div class="min-w-0">
          <div class="text-xs font-bold text-slate-800 dark:text-slate-100 truncate">${idx + 1}. ${escAttr(it.nama)}</div>
          ${subNote}
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <button type="button" onclick="window.AlRifaieAttendance.setIzinAlpaChoice(${idx},'Izin')" class="px-2.5 py-1.5 rounded-lg border text-[11px] font-bold transition-all ${btnStyle('Izin')}">Izin</button>
          <button type="button" onclick="window.AlRifaieAttendance.setIzinAlpaChoice(${idx},'Alpa')" class="px-2.5 py-1.5 rounded-lg border text-[11px] font-bold transition-all ${btnStyle('Alpa')}">Alpa</button>
          <button type="button" onclick="window.AlRifaieAttendance.setIzinAlpaChoice(${idx},'Lewati')" class="px-2 py-1.5 rounded-lg border text-[10px] font-semibold transition-all ${btnStyle('Lewati')}">Tunda</button>
        </div>
      </div>`;
    }).join('');

    const izinCnt = items.filter(x => x.choice === 'Izin').length;
    const alpaCnt = items.filter(x => x.choice === 'Alpa').length;
    const totalToSend = izinCnt + alpaCnt;

    if (summaryEl) {
      summaryEl.innerHTML = `<span class="text-amber-600 font-bold">${izinCnt} Izin</span> • <span class="text-red-600 font-bold">${alpaCnt} Alpa</span>`;
    }
    if (sendBtn) {
      sendBtn.disabled = totalToSend === 0;
      sendBtn.innerText = totalToSend > 0 ? ('Kirim (' + totalToSend + ' Nama)') : 'Pilih Izin / Alpa';
    }
  }

  function setIzinAlpaChoice(idx, choice) {
    if (!activeIzinAlpaContext || !activeIzinAlpaContext.items[idx]) return;
    activeIzinAlpaContext.items[idx].choice = choice;
    renderIzinAlpaModalList();
  }

  function setAllIzinAlpaChoice(choice) {
    if (!activeIzinAlpaContext) return;
    activeIzinAlpaContext.items.forEach(it => { it.choice = choice; });
    renderIzinAlpaModalList();
  }

  function submitIzinAlpaModal() {
    if (!activeIzinAlpaContext) return;
    const { type, target, tglSesi, items } = activeIzinAlpaContext;
    const selected = items.filter(it => it.choice === 'Izin' || it.choice === 'Alpa');
    if (!selected.length) {
      return global.Swal.fire('Belum Ada Pilihan', 'Pilih minimal 1 nama dengan status Izin atau Alpa untuk dikirim.', 'info');
    }

    const waktu = getWibTimeStr();
    const payloadItems = selected.map(it => ({
      nama: it.nama,
      kehadiran: it.choice,
      pelanggaran: [],
      nfcCode: it.nfcCode || '',
      qrCode: it.qrCode || '',
      metodeAbsen: 'Manual',
      waktuScan: waktu,
      autoScan: false
    }));

    const sendBtn = document.getElementById('btnSendIzinAlpa');
    if (sendBtn) sendBtn.disabled = true;
    global.Swal.fire({ title: 'Mengirim Izin & Alpa...', allowOutsideClick: false, didOpen: () => global.Swal.showLoading() });

    const sess = global.session || { role: 'user', name: 'Petugas' };
    global.google.script.run
      .withSuccessHandler(res => {
        if (sendBtn) sendBtn.disabled = false;
        // Simpan status Izin/Alpa ke daftar terverifikasi hari ini agar hilang dari daftar belum terverifikasi
        selected.forEach(it => {
          setVerifiedRecord(tglSesi, type, target, it.nama, {
            status: it.choice,
            method: 'Manual',
            nfcCode: it.nfcCode || '',
            qrCode: it.qrCode || '',
            waktuScan: waktu,
            pelanggaran: [],
            synced: true
          });
        });

        if (typeof global.closeModal === 'function') global.closeModal('izinAlpaModal');
        activeIzinAlpaContext = null;
        loadMembersEnhanced(type);

        if (typeof global.rekCache !== 'undefined') global.rekCache = {};
        if (typeof global.missingCache !== 'undefined') global.missingCache = null;
        if (typeof global.markTargetSubmittedInMissingCache === 'function') {
          global.markTargetSubmittedInMissingCache(type, target, tglSesi);
        }

        global.Swal.fire(
          res && res.success === false ? 'Peringatan' : 'Terkirim',
          (res && res.message) || (selected.length + ' data Izin/Alpa berhasil masuk ke database.'),
          res && res.success === false ? 'warning' : 'success'
        );
      })
      .withFailureHandler(err => {
        if (sendBtn) sendBtn.disabled = false;
        global.Swal.fire('Gagal Mengirim', (err && err.message) || 'Terjadi gangguan jaringan.', 'error');
      })
      .submitAbsensi({
        type: type,
        role: sess.role || 'user',
        petugas: sess.name || 'Petugas',
        target: target,
        tglSesi: tglSesi,
        isSingleScanUpdate: false,
        items: payloadItems
      });
  }

  // ===================== 7. LIVE QR CODE SCANNER MODAL =====================
  function ensureJsQrLoaded() {
    if (typeof global.jsQR === 'function') return Promise.resolve();
    if (jsQrLoadingPromise) return jsQrLoadingPromise;
    jsQrLoadingPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Library fallback QR tidak tersedia offline'));
      document.head.appendChild(s);
    });
    return jsQrLoadingPromise;
  }

  async function openQrScannerModal(mode, targetType) {
    qrScanMode = mode || 'attendance';
    qrScanTargetType = targetType || activeTabName || 'wb';
    qrLastCode = '';
    qrLastTime = 0;
    qrTorchOn = false;
    qrScanPausedForConfirm = false;

    const titleEl = document.getElementById('qrScannerTitle');
    const subEl = document.getElementById('qrScannerSubtitle');
    const manualInp = document.getElementById('qrManualCodeInput');
    const fb = document.getElementById('qrModalFeedback');
    if (manualInp) manualInp.value = '';
    if (fb) fb.classList.add('hidden');

    if (qrScanMode === 'bind_db') {
      if (titleEl) titleEl.innerText = 'Scan QR untuk Ditautkan';
      if (subEl) subEl.innerText = 'Arahkan kamera ke kartu QR agar otomatis masuk ke form database';
    } else {
      const labelMap = { wb: 'Wajib Belajar', takhassus: 'Takhassus', musyrif: 'Musyrif', pengajar: 'Pengajar' };
      if (titleEl) titleEl.innerText = 'Scan QR Absensi ' + (labelMap[qrScanTargetType] || '');
      if (subEl) subEl.innerText = 'Scan QR -> pilih pelanggaran (opsional) -> otomatis masuk database';
    }

    if (typeof global.openModal === 'function') {
      global.openModal('qrScannerModal');
    } else {
      document.getElementById('qrScannerModal')?.classList.remove('hidden');
    }

    await startQrCameraStream();
  }

  async function startQrCameraStream() {
    stopQrCameraStream();
    const video = document.getElementById('qrVideoPreview');
    const statusEl = document.getElementById('qrCameraStatusText');
    const torchBtn = document.getElementById('qrTorchBtn');
    if (!video) return;

    if (statusEl) statusEl.innerText = 'Membuka kamera belakang...';

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Perangkat tidak mendukung kamera WebView. Gunakan input kode manual di bawah.');
      }

      qrStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });

      video.srcObject = qrStream;
      video.setAttribute('playsinline', 'true');
      await video.play();

      if (torchBtn) {
        const track = qrStream.getVideoTracks()[0];
        const caps = track && typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};
        torchBtn.classList.toggle('hidden', !caps.torch);
      }

      qrBarcodeDetector = null;
      if ('BarcodeDetector' in global) {
        try {
          const formats = await global.BarcodeDetector.getSupportedFormats();
          if (formats && formats.includes('qr_code')) {
            qrBarcodeDetector = new global.BarcodeDetector({ formats: ['qr_code'] });
          }
        } catch (e) {
          qrBarcodeDetector = null;
        }
      }

      if (!qrBarcodeDetector) {
        try {
          await ensureJsQrLoaded();
        } catch (e) {
          if (statusEl) statusEl.innerText = 'Mode offline tanpa BarcodeDetector — gunakan input kode manual di bawah.';
          return;
        }
      }

      if (statusEl) statusEl.innerText = 'Arahkan QR Code tepat di dalam kotak pemindai';
      qrScanActive = true;
      scheduleNextQrFrame();
    } catch (err) {
      if (statusEl) {
        statusEl.innerText = 'Kamera tidak dapat dibuka (' + (err.message || 'izin ditolak') + '). Anda dapat mengetik kode QR manual di bawah.';
      }
    }
  }

  function scheduleNextQrFrame() {
    if (!qrScanActive) return;
    qrScanRaf = setTimeout(scanQrFrameOnce, 160);
  }

  async function scanQrFrameOnce() {
    if (!qrScanActive) return;
    if (qrScanPausedForConfirm) {
      scheduleNextQrFrame();
      return;
    }

    const video = document.getElementById('qrVideoPreview');
    if (!video || video.readyState < 2 || !video.videoWidth) {
      scheduleNextQrFrame();
      return;
    }

    try {
      let decoded = '';
      if (qrBarcodeDetector) {
        const results = await qrBarcodeDetector.detect(video);
        if (results && results.length > 0 && results[0].rawValue) {
          decoded = String(results[0].rawValue).trim();
        }
      } else if (typeof global.jsQR === 'function') {
        if (!qrCanvas) {
          qrCanvas = document.createElement('canvas');
          qrCanvasCtx = qrCanvas.getContext('2d', { willReadFrequently: true });
        }
        const maxW = 640;
        const scale = Math.min(1, maxW / video.videoWidth);
        const w = Math.floor(video.videoWidth * scale);
        const h = Math.floor(video.videoHeight * scale);
        if (qrCanvas.width !== w || qrCanvas.height !== h) {
          qrCanvas.width = w;
          qrCanvas.height = h;
        }
        qrCanvasCtx.drawImage(video, 0, 0, w, h);
        const imgData = qrCanvasCtx.getImageData(0, 0, w, h);
        const res = global.jsQR(imgData.data, w, h, { inversionAttempts: 'dontInvert' });
        if (res && res.data) decoded = String(res.data).trim();
      }

      if (decoded) {
        const now = Date.now();
        if (decoded !== qrLastCode || (now - qrLastTime) > 2200) {
          qrLastCode = decoded;
          qrLastTime = now;
          onQrCodeDecoded(decoded);
        }
      }
    } catch (e) {}

    scheduleNextQrFrame();
  }

  function onQrCodeDecoded(code) {
    const clean = String(code || '').trim().toUpperCase();
    if (!clean) return;

    if (qrScanMode === 'bind_db') {
      vibrateSafe(50);
      const inp = document.getElementById('dbQrCode');
      if (inp) inp.value = clean;
      updateDbModalQrPreview();
      closeQrScannerModal();
      return;
    }

    handleSmartAttendanceScan(clean, 'QR', qrScanTargetType, '');
  }

  function submitManualQrCode() {
    const inp = document.getElementById('qrManualCodeInput');
    if (!inp) return;
    const val = inp.value.trim();
    if (!val) return;
    inp.value = '';
    onQrCodeDecoded(val);
  }

  async function toggleQrTorch() {
    if (!qrStream) return;
    try {
      const track = qrStream.getVideoTracks()[0];
      if (!track) return;
      qrTorchOn = !qrTorchOn;
      await track.applyConstraints({ advanced: [{ torch: qrTorchOn }] });
      const btn = document.getElementById('qrTorchBtn');
      if (btn) {
        btn.classList.toggle('bg-amber-400', qrTorchOn);
        btn.classList.toggle('text-slate-900', qrTorchOn);
      }
    } catch (e) {}
  }

  function stopQrCameraStream() {
    qrScanActive = false;
    qrScanPausedForConfirm = false;
    if (qrScanRaf) {
      clearTimeout(qrScanRaf);
      qrScanRaf = null;
    }
    if (qrStream) {
      try { qrStream.getTracks().forEach(t => t.stop()); } catch (e) {}
      qrStream = null;
    }
    const video = document.getElementById('qrVideoPreview');
    if (video) {
      try { video.pause(); video.srcObject = null; } catch (e) {}
    }
  }

  function closeQrScannerModal() {
    stopQrCameraStream();
    if (typeof global.closeModal === 'function') {
      global.closeModal('qrScannerModal');
    } else {
      document.getElementById('qrScannerModal')?.classList.add('hidden');
    }
  }

  // ===================== 8. MANAJEMEN DATABASE: EDIT, NFC BIND & QR GENERATOR =====================
  function configureDbModalLabels(type) {
    const lbl1 = document.getElementById('dbLbl1');
    const lbl2 = document.getElementById('dbLbl2');
    const lbl3 = document.getElementById('dbLbl3');
    const lbl4 = document.getElementById('dbLbl4');
    const f3C = document.getElementById('dbField3C');
    const f4C = document.getElementById('dbField4C');
    const nfcWrap = document.getElementById('dbNfcSection');

    if (type === 'musyrif') {
      if (lbl1) lbl1.innerText = 'Nama Musyrif';
      if (lbl2) lbl2.innerText = 'Kamar Binaan (pisahkan koma jika >1)';
      if (lbl3) lbl3.innerText = 'Keterangan / Info';
      if (lbl4) lbl4.innerText = 'PIN Login';
      if (f3C) f3C.classList.remove('hidden');
      if (f4C) f4C.classList.remove('hidden');
      if (nfcWrap) nfcWrap.classList.add('hidden');
    } else if (type === 'pengajar') {
      if (lbl1) lbl1.innerText = 'Nama Pengajar';
      if (lbl2) lbl2.innerText = 'Kelas Ajar';
      if (lbl3) lbl3.innerText = 'Qismu / Mapel';
      if (lbl4) lbl4.innerText = 'PIN Login';
      if (f3C) f3C.classList.remove('hidden');
      if (f4C) f4C.classList.remove('hidden');
      if (nfcWrap) nfcWrap.classList.add('hidden');
    } else if (type === 'wb') {
      if (lbl1) lbl1.innerText = 'Nama Santri WB';
      if (lbl2) lbl2.innerText = 'Kamar';
      if (lbl3) lbl3.innerText = 'Keterangan (Opsional)';
      if (lbl4) lbl4.innerText = 'Info Tambahan (Opsional)';
      if (f3C) f3C.classList.remove('hidden');
      if (f4C) f4C.classList.add('hidden');
      if (nfcWrap) nfcWrap.classList.remove('hidden');
    } else {
      if (lbl1) lbl1.innerText = 'Nama Santri Takhassus';
      if (lbl2) lbl2.innerText = 'Kelas';
      if (lbl3) lbl3.innerText = 'Qismu';
      if (lbl4) lbl4.innerText = 'Info Tambahan (Opsional)';
      if (f3C) f3C.classList.remove('hidden');
      if (f4C) f4C.classList.add('hidden');
      if (nfcWrap) nfcWrap.classList.remove('hidden');
    }
  }

  function updateDbModalQrPreview() {
    const code = (document.getElementById('dbQrCode')?.value || '').trim();
    const wrap = document.getElementById('dbQrMiniPreviewWrap');
    const canvas = document.getElementById('dbQrMiniCanvas');
    if (!wrap || !canvas) return;
    if (!code || !global.AlRifaieQrLib) {
      wrap.classList.add('hidden');
      return;
    }
    try {
      global.AlRifaieQrLib.drawToCanvas(canvas, code, { size: 120, margin: 2 });
      wrap.classList.remove('hidden');
    } catch (e) {
      wrap.classList.add('hidden');
    }
  }

  function openDbModalEnhanced(rowIdxToEdit) {
    const type = global.currentDbType || (document.getElementById('dbTypeSelect')?.value || 'musyrif');
    configureDbModalLabels(type);
    nfcBindListening = false;

    const titleEl = document.getElementById('dbModalTitle');
    const rowEl = document.getElementById('dbRowIdx');
    const f1El = document.getElementById('dbF1');
    const f2El = document.getElementById('dbF2');
    const f3El = document.getElementById('dbF3');
    const f4El = document.getElementById('dbF4');
    const nfcEl = document.getElementById('dbNfcCode');
    const qrEl = document.getElementById('dbQrCode');

    const isEdit = rowIdxToEdit !== undefined && rowIdxToEdit !== null && rowIdxToEdit !== '';
    let existingItem = null;
    if (isEdit && Array.isArray(global.currentDbData)) {
      existingItem = global.currentDbData.find(r => String(r.idx) === String(rowIdxToEdit));
    }

    if (existingItem) {
      const idObj = getIdentity(type, existingItem.f1, existingItem);
      if (titleEl) titleEl.innerText = 'Edit Data & NFC / QR';
      if (rowEl) rowEl.value = existingItem.idx;
      if (f1El) f1El.value = existingItem.f1 || '';
      if (f2El) f2El.value = existingItem.f2 || '';
      if (f3El) f3El.value = existingItem.f3 || '';
      if (f4El) f4El.value = existingItem.f4 || '';
      if (nfcEl) nfcEl.value = idObj.nfcCode || '';
      if (qrEl) qrEl.value = idObj.qrCode || ((type === 'musyrif' || type === 'pengajar') ? generateDeterministicQrCode(type, existingItem.f1, existingItem.f2) : '');
    } else {
      if (titleEl) titleEl.innerText = 'Tambah Data Baru';
      if (rowEl) rowEl.value = '';
      if (f1El) f1El.value = '';
      if (f2El) f2El.value = '';
      if (f3El) f3El.value = '';
      if (f4El) f4El.value = '';
      if (nfcEl) nfcEl.value = '';
      if (qrEl) qrEl.value = '';
    }

    updateDbModalQrPreview();
    renderNfcStatusBadges();
    if (typeof global.openModal === 'function') global.openModal('dbModal');
  }

  function startNfcBindMode() {
    refreshNfcStatusFromNative();
    if (global.AndroidBridge && nfcStatusState.supported && !nfcStatusState.enabled) {
      global.Swal.fire({
        title: 'NFC HP Belum Aktif',
        text: 'Aktifkan NFC pada pengaturan smartphone Anda terlebih dahulu untuk menautkan kartu NFC.',
        icon: 'info',
        showCancelButton: true,
        confirmButtonText: 'Buka Pengaturan NFC',
        cancelButtonText: 'Batal'
      }).then(r => {
        if (r.isConfirmed) openAndroidNfcSettings();
      });
      return;
    }
    nfcBindListening = true;
    syncNfcLockForCurrentContext();
  }

  function stopNfcBindMode() {
    if (!nfcBindListening) return;
    nfcBindListening = false;
    syncNfcLockForCurrentContext();
  }

  function autoGenerateQrInDbModal() {
    const type = global.currentDbType || (document.getElementById('dbTypeSelect')?.value || 'musyrif');
    const nama = (document.getElementById('dbF1')?.value || '').trim();
    const grp = (document.getElementById('dbF2')?.value || '').trim();
    if (!nama) {
      global.Swal.fire('Isi Nama Dulu', 'Masukkan nama terlebih dahulu sebelum membuat QR Code.', 'warning');
      return;
    }
    const qrEl = document.getElementById('dbQrCode');
    if (qrEl) qrEl.value = generateDeterministicQrCode(type, nama, grp);
    updateDbModalQrPreview();
  }

  function filterDbTableEnhanced() {
    const q = (document.getElementById('dbSearchName')?.value || '').toLowerCase();
    const rm = document.getElementById('dbFilterRoom')?.value || '';
    const type = global.currentDbType || (document.getElementById('dbTypeSelect')?.value || 'musyrif');
    const list = Array.isArray(global.currentDbData) ? global.currentDbData : [];

    const filtered = list.filter(r => {
      if (rm && String(r.f2 || '') !== rm) return false;
      return String(r.f1 || '').toLowerCase().includes(q);
    });

    const isSantri = type === 'wb' || type === 'takhassus';
    const thead = document.getElementById('dbThead');
    const tbody = document.getElementById('dbTbody');
    if (!thead || !tbody) return;

    thead.innerHTML = `<tr>
      <th class="p-3">Nama</th>
      <th class="p-3">${type === 'wb' ? 'Kamar' : (type === 'takhassus' ? 'Kelas' : 'Kamar/Kelas')}</th>
      <th class="p-3">${isSantri ? 'NFC &amp; QR' : 'PIN &amp; QR Code'}</th>
      <th class="p-3 text-center">Aksi</th>
    </tr>`;

    if (!filtered.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="p-6 text-center text-slate-400">Tidak ada data ditemukan.</td></tr>';
      return;
    }

    tbody.innerHTML = filtered.map(r => {
      const idObj = getIdentity(type, r.f1, r);
      const nfcBadge = idObj.nfcCode
        ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-950/70 text-indigo-700 dark:text-indigo-300 text-[10px] font-bold"><i class="fa-solid fa-wifi rotate-90 text-[9px]"></i>${escAttr(idObj.nfcCode.slice(0, 12))}</span>`
        : (isSantri ? '<span class="text-[10px] text-slate-400">NFC: -</span>' : '');
      const qrBadge = idObj.qrCode
        ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-300 text-[10px] font-bold"><i class="fa-solid fa-qrcode text-[9px]"></i>${escAttr(idObj.qrCode)}</span>`
        : '<span class="text-[10px] text-slate-400">QR: -</span>';
      const extraInfo = [r.f3, r.f4].filter(Boolean).join(' • ');

      return `<tr class="hover:bg-slate-50 dark:hover:bg-slate-800/40">
        <td class="p-3 font-semibold text-slate-800 dark:text-slate-100">
          <div>${escAttr(r.f1)}</div>
          ${extraInfo ? '<div class="text-[10px] font-normal text-slate-400 mt-0.5">' + escAttr(extraInfo) + '</div>' : ''}
        </td>
        <td class="p-3 text-slate-600 dark:text-slate-300">${escAttr(r.f2 || '-')}</td>
        <td class="p-3">
          <div class="flex flex-wrap items-center gap-1">${nfcBadge}${qrBadge}</div>
        </td>
        <td class="p-3 text-center whitespace-nowrap">
          <div class="inline-flex items-center gap-1.5">
            <button type="button" onclick="window.AlRifaieAttendance.openQrCardPreview(${r.idx})" title="Lihat &amp; Unduh QR" class="w-8 h-8 rounded-lg bg-emerald-50 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 inline-flex items-center justify-center">
              <i class="fa-solid fa-qrcode text-xs"></i>
            </button>
            <button type="button" onclick="window.AlRifaieAttendance.openDbEdit(${r.idx})" title="Edit Data, NFC &amp; QR" class="w-8 h-8 rounded-lg bg-indigo-50 dark:bg-indigo-950/70 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 inline-flex items-center justify-center">
              <i class="fa-solid fa-pen-to-square text-xs"></i>
            </button>
            <button type="button" onclick="delDbItem('${type}',${r.idx})" title="Hapus" class="w-8 h-8 rounded-lg bg-red-50 dark:bg-red-950/60 text-red-600 dark:text-red-400 hover:bg-red-100 inline-flex items-center justify-center">
              <i class="fa-solid fa-trash text-xs"></i>
            </button>
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  function saveDbDataEnhanced(e) {
    e.preventDefault();
    stopNfcBindMode();
    const type = global.currentDbType || (document.getElementById('dbTypeSelect')?.value || 'musyrif');
    const rowIdx = document.getElementById('dbRowIdx')?.value || '';
    const f1 = (document.getElementById('dbF1')?.value || '').trim();
    const f2 = (document.getElementById('dbF2')?.value || '').trim();
    const f3 = (document.getElementById('dbF3')?.value || '').trim();
    const f4 = (document.getElementById('dbF4')?.value || '').trim();
    const nfcCode = (document.getElementById('dbNfcCode')?.value || '').trim().toUpperCase();
    let qrCode = (document.getElementById('dbQrCode')?.value || '').trim().toUpperCase();

    if (!f1) {
      global.Swal.fire('Nama Kosong', 'Nama wajib diisi.', 'warning');
      return;
    }

    if (!qrCode && (type === 'musyrif' || type === 'pengajar')) {
      qrCode = generateDeterministicQrCode(type, f1, f2);
    }

    setIdentity(type, f1, nfcCode, qrCode);

    global.google.script.run
      .withSuccessHandler(() => {
        if (typeof global.closeModal === 'function') global.closeModal('dbModal');
        if (typeof global.loadDbData === 'function') global.loadDbData();
        if (typeof global.loadInit === 'function') global.loadInit(true);
        global.Swal.fire('Tersimpan', 'Data database beserta kode NFC/QR berhasil disimpan.', 'success');
      })
      .withFailureHandler(err => {
        global.Swal.fire('Gagal Menyimpan', (err && err.message) || 'Terjadi gangguan jaringan.', 'error');
      })
      .saveDbData(type, rowIdx, {
        f1: f1,
        f2: f2,
        f3: f3,
        f4: f4,
        nfcCode: nfcCode,
        qrCode: qrCode
      });
  }

  function generateAllQrForCurrentDb() {
    const type = global.currentDbType || (document.getElementById('dbTypeSelect')?.value || 'musyrif');
    const list = Array.isArray(global.currentDbData) ? global.currentDbData : [];
    if (!list.length) {
      global.Swal.fire('Data Kosong', 'Belum ada daftar nama pada tabel ini.', 'info');
      return;
    }

    let generatedCount = 0;
    list.forEach(r => {
      const idObj = getIdentity(type, r.f1, r);
      if (!idObj.qrCode) {
        const newQr = generateDeterministicQrCode(type, r.f1, r.f2);
        setIdentity(type, r.f1, idObj.nfcCode, newQr);
        r.qrCode = newQr;
        generatedCount++;
      }
    });

    filterDbTableEnhanced();
    global.Swal.fire(
      'QR Code Siap',
      generatedCount > 0
        ? generatedCount + ' QR Code baru berhasil dibuat otomatis. Anda bisa langsung mengunduh PNG atau PDF.'
        : 'Seluruh nama pada tabel ini sudah memiliki QR Code aktif dan siap diunduh.',
      'success'
    );
  }

  // ===================== 9. EXPORT QR CARD (PNG & PDF — PER ORANG & SEMUA) =====================
  function buildQrCardCanvas(item) {
    const W = 720;
    const H = 960;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, W, H);

    const grad = ctx.createLinearGradient(0, 0, W, 165);
    grad.addColorStop(0, '#312E81');
    grad.addColorStop(0.65, '#4F46E5');
    grad.addColorStop(1, '#10B981');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, 165);

    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, W - 4, H - 4);

    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText('DEPARTEMEN PENDIDIKAN', W / 2, 66);
    ctx.font = '600 20px sans-serif';
    ctx.fillStyle = '#E0E7FF';
    ctx.fillText("YPM Al-Rifa'ie 2 Gondanglegi", W / 2, 102);

    const roleLabelMap = {
      musyrif: 'KARTU ABSENSI MUSYRIF',
      pengajar: 'KARTU ABSENSI PENGAJAR',
      wb: 'KARTU WAJIB BELAJAR',
      takhassus: 'KARTU SANTRI TAKHASSUS'
    };
    const roleLabel = roleLabelMap[item.type] || 'KARTU ABSENSI QR';
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.fillRect(W / 2 - 190, 118, 380, 34);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText(roleLabel, W / 2, 141);

    const qrSize = 460;
    const qrCanvasEl = document.createElement('canvas');
    global.AlRifaieQrLib.drawToCanvas(qrCanvasEl, item.qrCode, { size: qrSize, margin: 3, fg: '#0F172A', bg: '#FFFFFF' });

    const qrX = Math.floor((W - qrSize) / 2);
    const qrY = 205;
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 4;
    ctx.strokeRect(qrX - 14, qrY - 14, qrSize + 28, qrSize + 28);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(qrCanvasEl, qrX, qrY);

    ctx.fillStyle = '#0F172A';
    ctx.font = 'bold 34px sans-serif';
    const displayName = String(item.nama || 'Anggota').slice(0, 30);
    ctx.fillText(displayName, W / 2, 745);

    ctx.fillStyle = '#475569';
    ctx.font = '600 24px sans-serif';
    const subInfo = [item.group, item.extra].filter(Boolean).join(' • ') || roleLabel;
    ctx.fillText(subInfo.slice(0, 42), W / 2, 790);

    ctx.fillStyle = '#EEF2FF';
    ctx.fillRect(W / 2 - 180, 822, 360, 56);
    ctx.strokeStyle = '#C7D2FE';
    ctx.lineWidth = 2;
    ctx.strokeRect(W / 2 - 180, 822, 360, 56);
    ctx.fillStyle = '#3730A3';
    ctx.font = 'bold 26px monospace';
    ctx.fillText(item.qrCode, W / 2, 859);

    ctx.fillStyle = '#94A3B8';
    ctx.font = '600 16px sans-serif';
    ctx.fillText('Tunjukkan QR Code ini saat absensi berlangsung', W / 2, 922);

    return c;
  }

  function exportDataUrlFile(dataUrl, fileName, mimeType) {
    if (global.AndroidBridge && typeof global.AndroidBridge.saveBase64File === 'function') {
      global.AndroidBridge.saveBase64File(dataUrl, fileName, mimeType);
      return;
    }
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 250);
  }

  function openQrCardPreview(rowIdx) {
    const type = global.currentDbType || (document.getElementById('dbTypeSelect')?.value || 'musyrif');
    const list = Array.isArray(global.currentDbData) ? global.currentDbData : [];
    const item = list.find(r => String(r.idx) === String(rowIdx));
    if (!item) return;

    const idObj = getIdentity(type, item.f1, item);
    let qrCode = idObj.qrCode;
    if (!qrCode) {
      qrCode = generateDeterministicQrCode(type, item.f1, item.f2);
      setIdentity(type, item.f1, idObj.nfcCode, qrCode);
      filterDbTableEnhanced();
    }

    activeQrPreviewItem = {
      type: type,
      nama: item.f1 || '',
      group: item.f2 || '',
      extra: item.f3 || '',
      qrCode: qrCode,
      nfcCode: idObj.nfcCode || ''
    };

    const nameEl = document.getElementById('qrPreviewName');
    const subEl = document.getElementById('qrPreviewSub');
    const codeEl = document.getElementById('qrPreviewCode');
    const canvas = document.getElementById('qrPreviewCanvas');
    if (nameEl) nameEl.innerText = activeQrPreviewItem.nama;
    if (subEl) subEl.innerText = [activeQrPreviewItem.group, activeQrPreviewItem.extra].filter(Boolean).join(' • ') || type.toUpperCase();
    if (codeEl) codeEl.innerText = activeQrPreviewItem.qrCode;
    if (canvas && global.AlRifaieQrLib) {
      global.AlRifaieQrLib.drawToCanvas(canvas, activeQrPreviewItem.qrCode, { size: 240, margin: 3 });
    }

    if (typeof global.openModal === 'function') global.openModal('qrCardPreviewModal');
  }

  function downloadSingleQrPng() {
    if (!activeQrPreviewItem) return;
    const canvas = buildQrCardCanvas(activeQrPreviewItem);
    const dataUrl = canvas.toDataURL('image/png');
    const safeName = activeQrPreviewItem.nama.replace(/[^a-zA-Z0-9_-]/g, '_');
    exportDataUrlFile(dataUrl, 'QR_' + activeQrPreviewItem.type.toUpperCase() + '_' + safeName + '.png', 'image/png');
  }

  async function downloadSingleQrPdf() {
    if (!activeQrPreviewItem) return;
    try {
      global.Swal.fire({ title: 'Menyiapkan PDF QR...', allowOutsideClick: false, didOpen: () => global.Swal.showLoading() });
      if (typeof global.ensureHtml2Pdf === 'function') await global.ensureHtml2Pdf();
      const canvas = buildQrCardCanvas(activeQrPreviewItem);
      const cardDataUrl = canvas.toDataURL('image/png');

      const container = document.createElement('div');
      container.style.cssText = 'width:760px;padding:30px;background:#fff;text-align:center;font-family:sans-serif;';
      container.innerHTML = `<img src="${cardDataUrl}" style="width:420px;height:auto;margin:0 auto;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,0.08);" />`;

      const safeName = activeQrPreviewItem.nama.replace(/[^a-zA-Z0-9_-]/g, '_');
      const fileName = 'QR_' + activeQrPreviewItem.type.toUpperCase() + '_' + safeName + '.pdf';

      const pdfDataUri = await global.html2pdf().set({
        margin: 10,
        filename: fileName,
        image: { type: 'png', quality: 1 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
      }).from(container).outputPdf('datauristring');

      global.Swal.close();
      exportDataUrlFile(pdfDataUri, fileName, 'application/pdf');
    } catch (err) {
      global.Swal.fire('Gagal Ekspor PDF', (err && err.message) || 'Pastikan koneksi internet tersedia untuk memuat modul PDF sekali saja.', 'error');
    }
  }

  function getFilteredDbItemsWithQr() {
    const type = global.currentDbType || (document.getElementById('dbTypeSelect')?.value || 'musyrif');
    const q = (document.getElementById('dbSearchName')?.value || '').toLowerCase();
    const rm = document.getElementById('dbFilterRoom')?.value || '';
    const list = Array.isArray(global.currentDbData) ? global.currentDbData : [];
    const filtered = list.filter(r => {
      if (rm && String(r.f2 || '') !== rm) return false;
      return String(r.f1 || '').toLowerCase().includes(q);
    });

    return filtered.map(r => {
      const idObj = getIdentity(type, r.f1, r);
      let qrCode = idObj.qrCode;
      if (!qrCode) {
        qrCode = generateDeterministicQrCode(type, r.f1, r.f2);
        setIdentity(type, r.f1, idObj.nfcCode, qrCode);
      }
      return {
        type: type,
        nama: r.f1 || '',
        group: r.f2 || '',
        extra: r.f3 || '',
        qrCode: qrCode
      };
    });
  }

  async function downloadAllQrPdf() {
    const items = getFilteredDbItemsWithQr();
    if (!items.length) {
      return global.Swal.fire('Data Kosong', 'Tidak ada data pada tabel untuk dibuat PDF QR.', 'info');
    }
    filterDbTableEnhanced();

    try {
      global.Swal.fire({ title: 'Menyusun ' + items.length + ' Kartu QR PDF...', allowOutsideClick: false, didOpen: () => global.Swal.showLoading() });
      if (typeof global.ensureHtml2Pdf === 'function') await global.ensureHtml2Pdf();

      const typeLabel = items[0].type.toUpperCase();
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'width:760px;background:#fff;padding:12px;font-family:sans-serif;color:#0F172A;';

      const perPage = 9;
      let html = '';
      for (let start = 0; start < items.length; start += perPage) {
        const chunk = items.slice(start, start + perPage);
        html += `<div style="page-break-after:${start + perPage < items.length ? 'always' : 'auto'};padding:6px 0;">
          <div style="text-align:center;margin-bottom:12px;border-bottom:2px solid #4F46E5;padding-bottom:6px;">
            <div style="font-size:15px;font-weight:800;color:#312E81;">KARTU QR CODE ABSENSI ${escAttr(typeLabel)}</div>
            <div style="font-size:11px;color:#64748B;">Departemen Pendidikan — YPM Al-Rifa'ie 2 Gondanglegi</div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;">
            ${chunk.map(it => {
              const qrUrl = global.AlRifaieQrLib.toDataUrl(it.qrCode, { size: 220, margin: 2 });
              return `<div style="border:1.5px dashed #94A3B8;border-radius:12px;padding:10px 8px;text-align:center;background:#fff;">
                <div style="font-size:9px;font-weight:700;color:#4F46E5;letter-spacing:0.5px;">DEPT. PENDIDIKAN</div>
                <img src="${qrUrl}" style="width:142px;height:142px;margin:6px auto;display:block;image-rendering:pixelated;" />
                <div style="font-size:11px;font-weight:800;color:#0F172A;line-height:1.25;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escAttr(it.nama)}</div>
                <div style="font-size:9px;color:#64748B;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escAttr(it.group || typeLabel)}</div>
                <div style="display:inline-block;margin-top:5px;padding:2px 8px;border-radius:6px;background:#EEF2FF;color:#3730A3;font-size:9px;font-weight:800;font-family:monospace;">${escAttr(it.qrCode)}</div>
              </div>`;
            }).join('')}
          </div>
        </div>`;
      }
      wrapper.innerHTML = html;

      const fileName = 'Semua_QR_' + typeLabel + '_' + getTodayDateStr() + '.pdf';
      const pdfDataUri = await global.html2pdf().set({
        margin: 8,
        filename: fileName,
        image: { type: 'png', quality: 1 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
      }).from(wrapper).outputPdf('datauristring');

      global.Swal.close();
      exportDataUrlFile(pdfDataUri, fileName, 'application/pdf');
    } catch (err) {
      global.Swal.fire('Gagal Ekspor PDF', (err && err.message) || 'Terjadi kesalahan saat membuat PDF.', 'error');
    }
  }

  function downloadAllQrPng() {
    const items = getFilteredDbItemsWithQr();
    if (!items.length) {
      return global.Swal.fire('Data Kosong', 'Tidak ada data pada tabel untuk dibuat PNG QR.', 'info');
    }
    filterDbTableEnhanced();

    const typeLabel = items[0].type.toUpperCase();
    const cols = Math.min(4, Math.max(1, items.length));
    const rows = Math.ceil(items.length / cols);
    const cardW = 360;
    const cardH = 460;
    const gap = 24;
    const headerH = 110;
    const pad = 28;

    const canvas = document.createElement('canvas');
    canvas.width = pad * 2 + cols * cardW + (cols - 1) * gap;
    canvas.height = headerH + pad + rows * cardH + (rows - 1) * gap + pad;

    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#F8FAFC';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#312E81';
    ctx.fillRect(0, 0, canvas.width, headerH);
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.font = 'bold 30px sans-serif';
    ctx.fillText('LEMBAR QR CODE ABSENSI ' + typeLabel, canvas.width / 2, 48);
    ctx.fillStyle = '#C7D2FE';
    ctx.font = '600 20px sans-serif';
    ctx.fillText("Departemen Pendidikan • YPM Al-Rifa'ie 2 Gondanglegi (" + items.length + ' Kartu)', canvas.width / 2, 84);

    items.forEach((it, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const x = pad + col * (cardW + gap);
      const y = headerH + pad + row * (cardH + gap);

      const single = buildQrCardCanvas(it);
      ctx.drawImage(single, x, y, cardW, cardH);
    });

    const dataUrl = canvas.toDataURL('image/png');
    exportDataUrlFile(dataUrl, 'Semua_QR_' + typeLabel + '_' + getTodayDateStr() + '.png', 'image/png');
  }

  // ===================== 10. PUBLIC API =====================
  global.AlRifaieAttendance = {
    onTabChanged: function (tabId) {
      activeTabName = tabId || 'home';
      syncNfcLockForCurrentContext();
      if (tabId === 'wb' || tabId === 'takhassus' || tabId === 'musyrif' || tabId === 'pengajar') {
        refreshNfcStatusFromNative();
        if (global.AlRifaieAdminSettings && typeof global.AlRifaieAdminSettings.renderDeadlineBadges === 'function') {
          global.AlRifaieAdminSettings.renderDeadlineBadges();
        }
      }
      if (tabId === 'admin' && global.AlRifaieAdminSettings && typeof global.AlRifaieAdminSettings.onAdminTabOpened === 'function') {
        global.AlRifaieAdminSettings.onAdminTabOpened();
      }
    },
    onBundleApplied: function () {
      syncServerCoreDataToRegistry();
    },
    loadMembers: loadMembersEnhanced,
    onPelanggaranUpdated: onPelanggaranUpdated,
    // Tombol header daftar nama kini langsung membuka modal Input Izin / Alpa (khusus yang belum terverifikasi)
    submitRemainingAbsensi: function (type) {
      openIzinAlpaModal(type);
    },
    openIzinAlpaModal: openIzinAlpaModal,
    setIzinAlpaChoice: setIzinAlpaChoice,
    setAllIzinAlpaChoice: setAllIzinAlpaChoice,
    submitIzinAlpaModal: submitIzinAlpaModal,
    updateScanConfirmButtonLabel: updateScanConfirmButtonLabel,
    confirmScanSave: function () {
      commitScanConfirmToDatabase(false);
    },
    cancelScanConfirm: cancelScanConfirmPopup,
    onScanConfirmClosedExternally: function () {
      pendingScanConfirm = null;
      qrScanPausedForConfirm = false;
    },
    openQrScanner: openQrScannerModal,
    closeQrScanner: closeQrScannerModal,
    stopQrCameraOnly: stopQrCameraStream,
    submitManualQrCode: submitManualQrCode,
    toggleQrTorch: toggleQrTorch,
    openAndroidNfcSettings: openAndroidNfcSettings,
    filterDbTable: filterDbTableEnhanced,
    openDbEdit: openDbModalEnhanced,
    saveDbData: saveDbDataEnhanced,
    startNfcBindMode: startNfcBindMode,
    stopNfcBindMode: stopNfcBindMode,
    autoGenerateQrInDbModal: autoGenerateQrInDbModal,
    updateDbModalQrPreview: updateDbModalQrPreview,
    generateAllQrForCurrentDb: generateAllQrForCurrentDb,
    openQrCardPreview: openQrCardPreview,
    downloadSingleQrPng: downloadSingleQrPng,
    downloadSingleQrPdf: downloadSingleQrPdf,
    downloadAllQrPdf: downloadAllQrPdf,
    downloadAllQrPng: downloadAllQrPng
  };

  setTimeout(refreshNfcStatusFromNative, 600);
})(window);
