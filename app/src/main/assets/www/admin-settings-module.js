/**
 * =========================================================================
 * MODUL SETELAN ADMIN: BATAS WAKTU ABSEN, HAK AKSES PERAN, & DATA OFFLINE MANGKRAK
 * Departemen Pendidikan - YPM Al-Rifa'ie 2
 * =========================================================================
 */
(function (global) {
  'use strict';

  const DEADLINES_KEY = 'alrifaie_attendance_deadlines_v1';
  const ROLE_PERMS_KEY = 'alrifaie_role_permissions_v1';
  const STAFF_OVERRIDES_KEY = 'alrifaie_staff_perm_overrides_v1';
  const WALI_ACCOUNTS_KEY = 'alrifaie_walisantri_accounts_v1';

  const DRIVE_CONFIG_KEY = 'alrifaie_drive_backup_cfg_v1';

  const DEFAULT_DEADLINES = {
    wb: { enabled: true, time: '20:15' },
    takhassus: { enabled: true, time: '16:15' },
    musyrif: { enabled: true, time: '20:10' },
    pengajar: { enabled: true, time: '16:10' },
    izinDigital: { enabled: true, time: '16:00' }
  };

  const DEFAULT_DRIVE_CONFIG = {
    enabled: true,
    backupGaleri: true,
    backupSurat: true,
    rootFolderId: '',
    rootFolderName: 'Arsip_Departemen_Pendidikan_AlRifaie'
  };

  const ALL_PERMISSIONS = [
    { key: 'wb', label: 'Absen WB' },
    { key: 'takhassus', label: 'Absen Takhassus' },
    { key: 'musyrif', label: 'Absen Musyrif' },
    { key: 'pengajar', label: 'Absen Pengajar' },
    { key: 'izin', label: 'Izin Digital (Musyrif/Pengajar)' },
    { key: 'rekap', label: 'Statistik Rekap' },
    { key: 'tunggakan', label: 'Pantauan Tunggakan' },
    { key: 'simpanan', label: 'Dana Simpanan' },
    { key: 'operasional', label: 'Dana Operasional' },
    { key: 'surat', label: 'Arsip Surat' },
    { key: 'saranAdmin', label: 'Kotak Saran' },
    { key: 'database', label: 'Database' },
    { key: 'admin', label: 'Setelan & User' }
  ];

  const DEFAULT_ROLE_PERMS = {
    musyrif: ['wb', 'izin', 'rekap', 'tunggakan'],
    pengajar: ['takhassus', 'izin', 'rekap'],
    user: ['rekap'],
    walisantri: ['rekap']
  };

  let cachedOfflineQueue = [];
  let cachedWaliAccounts = [];
  let activeAdminCategory = 'akses';
  let activeAdminAksesSub = 'walisantri';
  let activePengurusFilter = 'all';
  let activeRekapCategory = 'ringkasan';

  function escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escJsInAttr(str) {
    return escHtml(
      String(str || '')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\r|\n/g, ' ')
    );
  }

  // ===================== 1. BATAS WAKTU ABSEN (AUTO-TERLAMBAT) =====================
  function loadDeadlines() {
    try {
      const raw = localStorage.getItem(DEADLINES_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      const merged = {};
      Object.keys(DEFAULT_DEADLINES).forEach(k => {
        const def = DEFAULT_DEADLINES[k];
        const cur = parsed && parsed[k] ? parsed[k] : {};
        merged[k] = {
          enabled: typeof cur.enabled === 'boolean' ? cur.enabled : def.enabled,
          time: /^\d{2}:\d{2}$/.test(String(cur.time || '')) ? String(cur.time) : def.time
        };
      });
      return merged;
    } catch (e) {
      return JSON.parse(JSON.stringify(DEFAULT_DEADLINES));
    }
  }

  function saveDeadlinesLocal(cfg) {
    try {
      const json = JSON.stringify(cfg);
      localStorage.setItem(DEADLINES_KEY, json);
      if (global.AndroidBridge && typeof global.AndroidBridge.syncAttendanceDeadlines === 'function') {
        global.AndroidBridge.syncAttendanceDeadlines(json);
      }
    } catch (e) {}
  }

  function getWibNowParts() {
    const now = new Date();
    const wib = new Date(now.getTime() + now.getTimezoneOffset() * 60000 + 25200000);
    return {
      hours: wib.getHours(),
      minutes: wib.getMinutes(),
      totalMinutes: wib.getHours() * 60 + wib.getMinutes()
    };
  }

  function evaluateDeadline(type) {
    const cfg = loadDeadlines()[type];
    if (!cfg || !cfg.enabled || !cfg.time) {
      return { enabled: false, isLate: false, diffMinutes: 0, deadlineTime: '' };
    }
    const parts = cfg.time.split(':');
    const limitH = parseInt(parts[0], 10);
    const limitM = parseInt(parts[1], 10);
    if (isNaN(limitH) || isNaN(limitM)) {
      return { enabled: false, isLate: false, diffMinutes: 0, deadlineTime: cfg.time };
    }
    const limitTotal = limitH * 60 + limitM;
    const now = getWibNowParts();
    const diff = now.totalMinutes - limitTotal;
    return {
      enabled: true,
      isLate: diff > 0,
      diffMinutes: Math.max(0, diff),
      deadlineTime: cfg.time
    };
  }

  function getWibTodayStr() {
    const now = new Date();
    const wib = new Date(now.getTime() + now.getTimezoneOffset() * 60000 + 25200000);
    const y = wib.getFullYear();
    const m = String(wib.getMonth() + 1).padStart(2, '0');
    const d = String(wib.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function evaluateIzinDeadline(startDateStr) {
    const cfg = loadDeadlines().izinDigital || DEFAULT_DEADLINES.izinDigital;
    if (!cfg || !cfg.enabled || !cfg.time) {
      return { enabled: false, isExpired: false, diffMinutes: 0, deadlineTime: '' };
    }
    const parts = cfg.time.split(':');
    const limitH = parseInt(parts[0], 10);
    const limitM = parseInt(parts[1], 10);
    if (isNaN(limitH) || isNaN(limitM)) {
      return { enabled: false, isExpired: false, diffMinutes: 0, deadlineTime: cfg.time };
    }
    const todayWib = getWibTodayStr();
    const targetDate = String(startDateStr || todayWib).trim().slice(0, 10);
    const now = getWibNowParts();
    const limitTotal = limitH * 60 + limitM;
    const diff = now.totalMinutes - limitTotal;
    const isPastDate = targetDate < todayWib;
    const isSameDayExpired = targetDate === todayWib && diff > 0;
    return {
      enabled: true,
      isExpired: isPastDate || isSameDayExpired,
      isPastDate: isPastDate,
      diffMinutes: Math.max(0, diff),
      deadlineTime: cfg.time
    };
  }

  function renderDeadlineBadges() {
    const all = loadDeadlines();
    ['wb', 'takhassus', 'musyrif', 'pengajar'].forEach(t => {
      const el = document.getElementById(t + 'DeadlineBadge');
      if (!el) return;
      const item = all[t];
      if (!item || !item.enabled) {
        el.classList.add('hidden');
        return;
      }
      const ev = evaluateDeadline(t);
      el.classList.remove('hidden');
      if (ev.isLate) {
        el.className = 'inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold bg-amber-100 dark:bg-amber-950/70 text-amber-800 dark:text-amber-300 border border-amber-300/60';
        el.innerHTML = `<i class="fa-solid fa-clock text-[9px]"></i><span>Lewat Batas ${escHtml(item.time)} WIB (+${ev.diffMinutes}m)</span>`;
      } else {
        el.className = 'inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-semibold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300';
        el.innerHTML = `<i class="fa-regular fa-clock text-[9px]"></i><span>Batas: ${escHtml(item.time)} WIB</span>`;
      }
    });
    if (global.AlRifaieSmart && typeof global.AlRifaieSmart.renderIzinDeadlineBanner === 'function') {
      global.AlRifaieSmart.renderIzinDeadlineBanner();
    }
  }

  function populateDeadlineSettingsForm() {
    const all = loadDeadlines();
    ['wb', 'takhassus', 'musyrif', 'pengajar', 'izinDigital'].forEach(t => {
      const chk = document.getElementById('dlEnable_' + t);
      const inp = document.getElementById('dlTime_' + t);
      if (chk) chk.checked = Boolean(all[t] && all[t].enabled);
      if (inp) inp.value = (all[t] && all[t].time) || DEFAULT_DEADLINES[t].time;
    });
  }

  function saveAttendanceDeadlines(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    const next = {};
    ['wb', 'takhassus', 'musyrif', 'pengajar', 'izinDigital'].forEach(t => {
      const chk = document.getElementById('dlEnable_' + t);
      const inp = document.getElementById('dlTime_' + t);
      next[t] = {
        enabled: Boolean(chk && chk.checked),
        time: (inp && inp.value) ? inp.value : DEFAULT_DEADLINES[t].time
      };
    });
    saveDeadlinesLocal(next);
    renderDeadlineBadges();

    if (global.appSettings && typeof global.appSettings === 'object') {
      global.appSettings.attendanceDeadlines = next;
    }

    syncExtraSettingsToServer({ attendanceDeadlines: next }, 'Batas waktu absen & batas Izin Digital berhasil disimpan.');
  }

  // ===================== 2. PENGATURAN HAK AKSES PERAN & FITUR =====================
  function loadRolePermissions() {
    try {
      const raw = localStorage.getItem(ROLE_PERMS_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return {
        musyrif: Array.isArray(parsed && parsed.musyrif) ? parsed.musyrif : DEFAULT_ROLE_PERMS.musyrif.slice(),
        pengajar: Array.isArray(parsed && parsed.pengajar) ? parsed.pengajar : DEFAULT_ROLE_PERMS.pengajar.slice(),
        user: Array.isArray(parsed && parsed.user) ? parsed.user : DEFAULT_ROLE_PERMS.user.slice(),
        walisantri: Array.isArray(parsed && parsed.walisantri) ? parsed.walisantri : DEFAULT_ROLE_PERMS.walisantri.slice()
      };
    } catch (e) {
      return JSON.parse(JSON.stringify(DEFAULT_ROLE_PERMS));
    }
  }

  function saveRolePermissionsLocal(cfg) {
    try {
      localStorage.setItem(ROLE_PERMS_KEY, JSON.stringify(cfg));
    } catch (e) {}
  }

  function getStaffOverrideKey(role, name) {
    return String(role || '').trim().toLowerCase() + ':' + String(name || '').trim().toLowerCase();
  }

  function loadStaffPermissionOverrides() {
    try {
      const raw = localStorage.getItem(STAFF_OVERRIDES_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function saveStaffPermissionOverridesLocal(map) {
    try {
      localStorage.setItem(STAFF_OVERRIDES_KEY, JSON.stringify(map || {}));
    } catch (e) {}
  }

  function getEffectivePermissionsForSession(sess) {
    if (!sess) return [];
    if (sess.role === 'admin') return ['ALL'];
    const roleCfg = loadRolePermissions();
    const overrides = loadStaffPermissionOverrides();
    if (sess.role === 'musyrif') {
      const ov = overrides[getStaffOverrideKey('musyrif', sess.name)];
      if (Array.isArray(ov)) return ov;
      return roleCfg.musyrif || DEFAULT_ROLE_PERMS.musyrif;
    }
    if (sess.role === 'pengajar') {
      const ov = overrides[getStaffOverrideKey('pengajar', sess.name)];
      if (Array.isArray(ov)) return ov;
      return roleCfg.pengajar || DEFAULT_ROLE_PERMS.pengajar;
    }
    if (sess.role === 'walisantri') {
      const base = Array.isArray(sess.permissions) ? sess.permissions : (roleCfg.walisantri || DEFAULT_ROLE_PERMS.walisantri);
      return base.filter(k => k !== 'izin');
    }
    if (Array.isArray(sess.permissions) && sess.permissions.length > 0) return sess.permissions;
    return roleCfg.user || DEFAULT_ROLE_PERMS.user;
  }

  function renderRolePermissionsUI() {
    const container = document.getElementById('rolePermissionsMatrix');
    if (!container) return;
    const cfg = loadRolePermissions();
    const roles = [
      { key: 'walisantri', title: 'Akun Bersama Wali Santri', desc: 'Hak akses fitur untuk akun bersama Wali Santri (Beranda cari nama anak & Galeri selalu aktif)', badgeCls: 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300' },
      { key: 'musyrif', title: 'Peran Musyrif', desc: 'Akses fitur untuk semua akun login sebagai Musyrif', badgeCls: 'bg-sky-50 dark:bg-sky-950/60 text-sky-700 dark:text-sky-300' },
      { key: 'pengajar', title: 'Peran Pengajar', desc: 'Akses fitur untuk semua akun login sebagai Pengajar', badgeCls: 'bg-teal-50 dark:bg-teal-950/60 text-teal-700 dark:text-teal-300' },
      { key: 'user', title: 'Default Pengurus', desc: 'Hak akses bawaan saat menambah pengurus baru', badgeCls: 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300' }
    ];

    container.innerHTML = roles.map(r => {
      const rolePermPool = r.key === 'walisantri'
        ? ALL_PERMISSIONS.filter(p => p.key !== 'izin')
        : ALL_PERMISSIONS;
      const selected = (cfg[r.key] || []).filter(k => rolePermPool.some(p => p.key === k));
      const checkboxes = rolePermPool.map(p => {
        const checked = selected.includes(p.key) ? 'checked' : '';
        return `<label class="flex items-center gap-2 p-2 rounded-lg bg-white dark:bg-slate-900/70 border border-slate-200/80 dark:border-slate-700/70 cursor-pointer hover:border-indigo-400 transition-colors text-[11px] font-medium">
          <input type="checkbox" name="rolePerm_${r.key}" value="${p.key}" ${checked} class="accent-indigo-600 rounded">
          <span class="truncate">${escHtml(p.label)}</span>
        </label>`;
      }).join('');

      return `<div class="p-3.5 rounded-xl bg-slate-50/80 dark:bg-slate-800/40 border border-slate-200/80 dark:border-slate-700/70 space-y-2.5">
        <div class="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-bold ${r.badgeCls}">${escHtml(r.title)}</span>
            <p class="text-[11px] text-slate-500 mt-1">${escHtml(r.desc)}</p>
          </div>
          <span class="text-[10px] font-bold text-slate-400">${selected.length} / ${rolePermPool.length} Fitur</span>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">${checkboxes}</div>
      </div>`;
    }).join('');
  }

  function saveRolePermissions(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    const next = {};
    ['musyrif', 'pengajar', 'user', 'walisantri'].forEach(roleKey => {
      const vals = Array.from(document.querySelectorAll('input[name="rolePerm_' + roleKey + '"]:checked')).map(c => c.value);
      next[roleKey] = vals;
    });
    if (!next.musyrif.length || !next.pengajar.length) {
      if (typeof global.Swal !== 'undefined') {
        global.Swal.fire('Perhatian', 'Minimal pilih 1 hak akses untuk Musyrif dan Pengajar.', 'warning');
      }
      return;
    }
    saveRolePermissionsLocal(next);
    const sharedWali = getPrimarySharedWaliAccount();
    if (sharedWali) {
      const updatedShared = Object.assign({}, sharedWali, { akses: (next.walisantri || []).filter(k => k !== 'izin') });
      writeLocalWaliAccounts([updatedShared]);
      renderWaliSantriTable();
    }
    renderRolePermissionsUI();

    if (global.appSettings && typeof global.appSettings === 'object') {
      global.appSettings.rolePermissions = next;
    }

    if (global.session && global.session.role !== 'admin') {
      global.session.permissions = getEffectivePermissionsForSession(global.session);
      if (typeof global.refreshPermissionsUI === 'function') {
        global.refreshPermissionsUI();
      }
    }

    syncExtraSettingsToServer({ rolePermissions: next }, 'Pengaturan hak akses peran & fitur berhasil disimpan.');
  }

  // ===================== 2B. MANAJEMEN AKUN & AUTENTIKASI WALI SANTRI =====================
  function generateRandomSalt() {
    try {
      if (global.crypto && typeof global.crypto.getRandomValues === 'function') {
        const arr = new Uint8Array(12);
        global.crypto.getRandomValues(arr);
        return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
      }
    } catch (e) {}
    return (Date.now().toString(16) + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2)).slice(0, 24);
  }

  function sha256FallbackHex(ascii) {
    function rightRotate(v, amt) { return (v >>> amt) | (v << (32 - amt)); }
    const maxWord = Math.pow(2, 32);
    let result = '';
    const words = [];
    const utf8 = unescape(encodeURIComponent(String(ascii)));
    const bitLen = utf8.length * 8;
    const hash = [];
    const k = [];
    let primeCounter = 0;
    const isComposite = {};
    for (let candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (let i = 0; i < 313; i += candidate) isComposite[i] = candidate;
        hash[primeCounter] = (Math.pow(candidate, 0.5) * maxWord) | 0;
        k[primeCounter++] = (Math.pow(candidate, 1 / 3) * maxWord) | 0;
      }
    }
    const padded = utf8 + '\x80';
    let padLen = padded.length;
    while (padLen % 64 - 56) padLen++;
    const full = padded + '\x00'.repeat(padLen - padded.length);
    for (let i = 0; i < full.length; i++) {
      const j = full.charCodeAt(i);
      words[i >> 2] |= j << ((3 - i) % 4) * 8;
    }
    words[words.length] = (bitLen / maxWord) | 0;
    words[words.length] = bitLen | 0;
    for (let j = 0; j < words.length;) {
      const w = words.slice(j, j += 16);
      const oldHash = hash.slice(0, 8);
      for (let i = 0; i < 64; i++) {
        const w15 = w[i - 15], w2 = w[i - 2];
        const a = hash[0], e = hash[4];
        const temp1 = hash[7]
          + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25))
          + ((e & hash[5]) ^ ((~e) & hash[6]))
          + k[i]
          + (w[i] = (i < 16) ? w[i] : (
            w[i - 16]
            + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3))
            + w[i - 7]
            + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))
          ) | 0);
        const temp2 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22))
          + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash.unshift((temp1 + temp2) | 0);
        hash[4] = (hash[4] + temp1) | 0;
        hash.pop();
      }
      for (let i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
    }
    for (let i = 0; i < 8; i++) {
      for (let j = 3; j + 1; j--) {
        const b = (hash[i] >> (j * 8)) & 255;
        result += (b < 16 ? '0' : '') + b.toString(16);
      }
    }
    return result;
  }

  async function hashPasswordWithSalt(password, salt) {
    const input = String(salt || '') + ':' + String(password || '');
    try {
      if (global.crypto && global.crypto.subtle && typeof TextEncoder !== 'undefined') {
        const bytes = new TextEncoder().encode(input);
        const digest = await global.crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
      }
    } catch (e) {}
    return sha256FallbackHex(input);
  }

  function constantTimeEqual(a, b) {
    const sa = String(a || '');
    const sb = String(b || '');
    if (!sa || sa.length !== sb.length) return false;
    let diff = 0;
    for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
    return diff === 0;
  }

  function readLocalWaliAccounts() {
    try {
      const raw = localStorage.getItem(WALI_ACCOUNTS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function writeLocalWaliAccounts(list) {
    cachedWaliAccounts = Array.isArray(list) ? list : [];
    try {
      localStorage.setItem(WALI_ACCOUNTS_KEY, JSON.stringify(cachedWaliAccounts));
    } catch (e) {}
  }

  function getPermLabel(key) {
    const found = ALL_PERMISSIONS.find(p => p.key === key);
    return found ? found.label : key;
  }

  const SHARED_WALI_ACCOUNT_ID = 'wali_shared_main';

  function getPrimarySharedWaliAccount() {
    const list = cachedWaliAccounts.length ? cachedWaliAccounts : readLocalWaliAccounts();
    cachedWaliAccounts = list;
    if (!list.length) return null;
    return list.find(x => String(x.id) === SHARED_WALI_ACCOUNT_ID || x.sharedSingle) || list[0];
  }

  function renderWaliSantriTable() {
    const countBadge = document.getElementById('badgeCountWali');
    const statusBadge = document.getElementById('wsSharedStatusBadge');
    const userEl = document.getElementById('wsSharedUsername');
    const pwdEl = document.getElementById('wsSharedPassword');
    const pwdHintEl = document.getElementById('wsSharedPasswordHint');
    const namaEl = document.getElementById('wsSharedNamaWali');
    const metaEl = document.getElementById('wsSharedMetaInfo');

    const acc = getPrimarySharedWaliAccount();
    if (countBadge) countBadge.innerText = acc ? '1' : '0';

    if (acc) {
      if (statusBadge) {
        statusBadge.innerText = 'Aktif • 1 Akun Bersama';
        statusBadge.className = 'px-2.5 py-1 rounded-full text-[10px] font-bold bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200/70 dark:border-emerald-800/60';
      }
      if (userEl && document.activeElement !== userEl) userEl.value = acc.username || '';
      if (pwdEl && document.activeElement !== pwdEl) {
        pwdEl.value = '';
        pwdEl.required = false;
        pwdEl.placeholder = 'Kosongkan jika password tetap';
      }
      if (pwdHintEl) pwdHintEl.innerText = 'Password tersimpan terenkripsi. Isi hanya jika ingin mengganti password.';
      if (namaEl && document.activeElement !== namaEl) namaEl.value = acc.namaWali || 'Wali Santri';
      if (metaEl) metaEl.innerHTML = `Username aktif: <b class="font-mono text-emerald-700 dark:text-emerald-300">${escHtml(acc.username)}</b> &bull; Bisa dipakai bersama oleh semua Wali Santri.`;

      const perms = (Array.isArray(acc.akses) ? acc.akses : (loadRolePermissions().walisantri || ['rekap'])).filter(k => k !== 'izin');
      document.querySelectorAll('input[name="wsSharedPerm"]').forEach(c => {
        c.checked = perms.includes(c.value);
      });
    } else {
      if (statusBadge) {
        statusBadge.innerText = 'Belum Diatur';
        statusBadge.className = 'px-2.5 py-1 rounded-full text-[10px] font-bold bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 border border-amber-200/70 dark:border-amber-800/60';
      }
      if (userEl && !userEl.value && document.activeElement !== userEl) userEl.value = 'walisantri';
      if (pwdEl) {
        pwdEl.required = true;
        pwdEl.placeholder = 'Minimal 4 karakter';
      }
      if (pwdHintEl) pwdHintEl.innerText = 'Buat password bersama untuk seluruh Wali Santri (minimal 4 karakter).';
      if (metaEl) metaEl.innerText = 'Atur 1 username & password di atas, lalu bagikan ke grup Wali Santri.';
      const defPerms = (loadRolePermissions().walisantri || ['rekap']).filter(k => k !== 'izin');
      document.querySelectorAll('input[name="wsSharedPerm"]').forEach(c => {
        c.checked = defPerms.includes(c.value);
      });
    }
  }

  async function saveSharedWaliAccount(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    const username = (document.getElementById('wsSharedUsername')?.value || '').trim();
    const password = document.getElementById('wsSharedPassword')?.value || '';
    const namaWali = (document.getElementById('wsSharedNamaWali')?.value || '').trim() || 'Wali Santri';
    const akses = Array.from(document.querySelectorAll('input[name="wsSharedPerm"]:checked'))
      .map(c => c.value)
      .filter(k => k !== 'izin');

    if (username.length < 3) {
      if (typeof global.Swal !== 'undefined') global.Swal.fire('Perhatian', 'Username bersama minimal 3 karakter.', 'warning');
      return;
    }

    const existing = getPrimarySharedWaliAccount();
    if (!existing && password.length < 4) {
      if (typeof global.Swal !== 'undefined') global.Swal.fire('Perhatian', 'Password bersama minimal 4 karakter.', 'warning');
      return;
    }
    if (existing && password && password.length < 4) {
      if (typeof global.Swal !== 'undefined') global.Swal.fire('Perhatian', 'Password baru minimal 4 karakter.', 'warning');
      return;
    }

    let salt = existing && existing.salt ? existing.salt : generateRandomSalt();
    let passwordHash = existing && existing.passwordHash ? existing.passwordHash : '';
    if (password) {
      salt = generateRandomSalt();
      passwordHash = await hashPasswordWithSalt(password, salt);
    }

    const recordId = (existing && existing.id) ? String(existing.id) : SHARED_WALI_ACCOUNT_ID;
    const localRecord = {
      id: recordId,
      username: username,
      namaWali: namaWali,
      namaSantri: '',
      akses: akses,
      salt: salt,
      passwordHash: passwordHash,
      sharedSingle: true,
      localOnly: true,
      createdAt: (existing && existing.createdAt) || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Simpan ketat hanya 1 akun bersama Wali Santri
    writeLocalWaliAccounts([localRecord]);

    // Sinkronkan juga konfigurasi role permissions default walisantri
    const roleCfg = loadRolePermissions();
    roleCfg.walisantri = akses.slice();
    try { localStorage.setItem(ROLE_PERMS_KEY, JSON.stringify(roleCfg)); } catch (err) {}
    renderRolePermissionsUI();
    renderWaliSantriTable();

    const serverPayload = {
      id: recordId,
      username: username,
      namaWali: namaWali,
      namaSantri: '',
      akses: akses,
      sharedSingle: true
    };
    if ((!existing || password || (existing && existing.localOnly)) && salt && passwordHash) {
      serverPayload.salt = salt;
      serverPayload.passwordHash = passwordHash;
    }

    try {
      if (global.google && global.google.script && global.google.script.run && typeof global.google.script.run.saveWaliSantriUser === 'function') {
        global.google.script.run
          .withSuccessHandler(res => {
            if (res && res.success) {
              const finalId = res.id || recordId;
              writeLocalWaliAccounts([Object.assign({}, localRecord, { id: finalId, localOnly: false })]);
              renderWaliSantriTable();
            }
            if (typeof global.Swal !== 'undefined') {
              global.Swal.fire('Tersimpan', `Akun bersama Wali Santri (${username}) berhasil disimpan & aktif untuk semua wali.`, 'success');
            }
          })
          .withFailureHandler(() => {
            if (typeof global.Swal !== 'undefined') {
              global.Swal.fire('Tersimpan Lokal', `Akun bersama Wali Santri (${username}) tersimpan di perangkat dan siap digunakan.`, 'success');
            }
          })
          .saveWaliSantriUser(serverPayload);
        return;
      }
    } catch (err) {}

    if (typeof global.Swal !== 'undefined') {
      global.Swal.fire('Tersimpan', `Akun bersama Wali Santri (${username}) berhasil disimpan.`, 'success');
    }
  }

  function loadWaliSantriAccounts() {
    cachedWaliAccounts = readLocalWaliAccounts();
    renderWaliSantriTable();
    try {
      if (global.google && global.google.script && global.google.script.run && typeof global.google.script.run.getWaliSantriUsers === 'function') {
        global.google.script.run
          .withSuccessHandler(serverList => {
            if (!Array.isArray(serverList) || !serverList.length) return;
            const localMain = getPrimarySharedWaliAccount();
            const svMain = serverList.find(x => String(x.id) === SHARED_WALI_ACCOUNT_ID || x.sharedSingle) || serverList[0];
            if (!svMain) return;
            const mergedMain = Object.assign({}, localMain || {}, svMain, {
              sharedSingle: true,
              akses: (Array.isArray(svMain.akses) ? svMain.akses : ((localMain && localMain.akses) || ['rekap'])).filter(k => k !== 'izin')
            });
            writeLocalWaliAccounts([mergedMain]);
            renderWaliSantriTable();
          })
          .withFailureHandler(() => {})
          .getWaliSantriUsers();
      }
    } catch (e) {}
  }

  function openWaliModal(id) {
    const targetId = String(id || '').trim();
    const idEl = document.getElementById('wsId');
    const userEl = document.getElementById('wsUsername');
    const pwdEl = document.getElementById('wsPassword');
    const pwdHintEl = document.getElementById('wsPasswordHint');
    const namaEl = document.getElementById('wsNamaWali');
    const santriEl = document.getElementById('wsNamaSantri');
    const titleEl = document.getElementById('waliModalTitle');

    if (idEl) idEl.value = targetId;
    document.querySelectorAll('input[name="wsPerm"]').forEach(c => { c.checked = false; });

    if (targetId) {
      const list = cachedWaliAccounts.length ? cachedWaliAccounts : readLocalWaliAccounts();
      const acc = list.find(x => String(x.id) === targetId);
      if (acc) {
        if (titleEl) titleEl.innerText = 'Edit Akun Wali Santri';
        if (userEl) userEl.value = acc.username || '';
        if (pwdEl) { pwdEl.value = ''; pwdEl.required = false; pwdEl.placeholder = 'Kosongkan jika tidak mengubah password'; }
        if (pwdHintEl) pwdHintEl.innerText = 'Kosongkan kolom password jika hanya ingin mengubah nama atau hak akses.';
        if (namaEl) namaEl.value = acc.namaWali || '';
        if (santriEl) santriEl.value = acc.namaSantri || '';
        const perms = Array.isArray(acc.akses) ? acc.akses : [];
        document.querySelectorAll('input[name="wsPerm"]').forEach(c => {
          if (perms.includes(c.value)) c.checked = true;
        });
      }
    } else {
      if (titleEl) titleEl.innerText = 'Tambah Akun Wali Santri';
      if (userEl) userEl.value = '';
      if (pwdEl) { pwdEl.value = ''; pwdEl.required = true; pwdEl.placeholder = 'Minimal 4 karakter'; }
      if (pwdHintEl) pwdHintEl.innerText = 'Password akan dienkripsi otomatis sebelum disimpan.';
      if (namaEl) namaEl.value = '';
      if (santriEl) santriEl.value = '';
      const defPerms = loadRolePermissions().walisantri || ['rekap'];
      document.querySelectorAll('input[name="wsPerm"]').forEach(c => {
        if (defPerms.includes(c.value)) c.checked = true;
      });
    }

    if (typeof global.openModal === 'function') global.openModal('waliSantriModal');
  }

  async function saveWaliSantriAction(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    const id = (document.getElementById('wsId')?.value || '').trim();
    const username = (document.getElementById('wsUsername')?.value || '').trim();
    const password = document.getElementById('wsPassword')?.value || '';
    const namaWali = (document.getElementById('wsNamaWali')?.value || '').trim();
    const namaSantri = (document.getElementById('wsNamaSantri')?.value || '').trim();
    const akses = Array.from(document.querySelectorAll('input[name="wsPerm"]:checked')).map(c => c.value);

    if (username.length < 3) {
      if (typeof global.Swal !== 'undefined') global.Swal.fire('Perhatian', 'Username minimal 3 karakter.', 'warning');
      return;
    }
    if (!id && password.length < 4) {
      if (typeof global.Swal !== 'undefined') global.Swal.fire('Perhatian', 'Password akun baru minimal 4 karakter.', 'warning');
      return;
    }
    if (id && password && password.length < 4) {
      if (typeof global.Swal !== 'undefined') global.Swal.fire('Perhatian', 'Password baru minimal 4 karakter.', 'warning');
      return;
    }

    const list = readLocalWaliAccounts();
    const dup = list.find(x => String(x.username || '').toLowerCase() === username.toLowerCase() && String(x.id) !== id);
    if (dup) {
      if (typeof global.Swal !== 'undefined') global.Swal.fire('Username Sudah Dipakai', 'Gunakan username lain yang unik.', 'warning');
      return;
    }

    let existing = id ? list.find(x => String(x.id) === id) : null;
    let salt = existing && existing.salt ? existing.salt : generateRandomSalt();
    let passwordHash = existing && existing.passwordHash ? existing.passwordHash : '';
    if (password) {
      salt = generateRandomSalt();
      passwordHash = await hashPasswordWithSalt(password, salt);
    }

    const recordId = id || ('ws_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6));
    const localRecord = {
      id: recordId,
      username: username,
      namaWali: namaWali || username,
      namaSantri: namaSantri,
      akses: akses,
      salt: salt,
      passwordHash: passwordHash,
      localOnly: true,
      createdAt: (existing && existing.createdAt) || new Date().toISOString()
    };

    const nextList = existing
      ? list.map(x => String(x.id) === recordId ? localRecord : x)
      : [localRecord].concat(list);
    writeLocalWaliAccounts(nextList);
    renderWaliSantriTable();
    if (typeof global.closeModal === 'function') global.closeModal('waliSantriModal');

    // Sinkronkan ke server Google Apps Script (kirim salt + passwordHash hanya untuk akun baru atau saat password diubah)
    const serverPayload = {
      id: id || '',
      username: username,
      namaWali: namaWali || username,
      namaSantri: namaSantri,
      akses: akses
    };
    if ((!id || password || (existing && existing.localOnly)) && salt && passwordHash) {
      serverPayload.salt = salt;
      serverPayload.passwordHash = passwordHash;
    }

    try {
      if (global.google && global.google.script && global.google.script.run && typeof global.google.script.run.saveWaliSantriUser === 'function') {
        global.google.script.run
          .withSuccessHandler(res => {
            if (res && res.success) {
              const finalId = res.id || recordId;
              const syncedList = readLocalWaliAccounts().map(x =>
                String(x.id) === recordId ? Object.assign({}, x, { id: finalId, localOnly: false }) : x
              );
              writeLocalWaliAccounts(syncedList);
              renderWaliSantriTable();
            }
            if (typeof global.Swal !== 'undefined') {
              global.Swal.fire('Berhasil', 'Akun Wali Santri & hak aksesnya berhasil disimpan.', 'success');
            }
          })
          .withFailureHandler(() => {
            if (typeof global.Swal !== 'undefined') {
              global.Swal.fire('Tersimpan', 'Akun Wali Santri tersimpan di perangkat dan siap digunakan login.', 'success');
            }
          })
          .saveWaliSantriUser(serverPayload);
        return;
      }
    } catch (err) {}

    if (typeof global.Swal !== 'undefined') {
      global.Swal.fire('Berhasil', 'Akun Wali Santri & hak aksesnya berhasil disimpan.', 'success');
    }
  }

  function deleteWaliSantri(id) {
    const targetId = String(id || '').trim();
    if (!targetId) return;
    const executeDel = () => {
      const next = readLocalWaliAccounts().filter(x => String(x.id) !== targetId);
      writeLocalWaliAccounts(next);
      renderWaliSantriTable();
      try {
        if (global.google && global.google.script && global.google.script.run && typeof global.google.script.run.deleteWaliSantriUser === 'function') {
          global.google.script.run
            .withSuccessHandler(() => {})
            .withFailureHandler(() => {})
            .deleteWaliSantriUser(targetId);
        }
      } catch (e) {}
      if (typeof global.Swal !== 'undefined') {
        global.Swal.fire('Terhapus', 'Akun Wali Santri telah dihapus.', 'success');
      }
    };

    if (typeof global.Swal !== 'undefined') {
      global.Swal.fire({
        title: 'Hapus Akun Wali Santri?',
        text: 'Wali Santri tidak lagi bisa login menggunakan akun ini.',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#DC2626',
        cancelButtonColor: '#64748B',
        confirmButtonText: 'Ya, Hapus',
        cancelButtonText: 'Batal'
      }).then(r => { if (r.isConfirmed) executeDel(); });
    } else {
      executeDel();
    }
  }

  async function verifyLocalWaliAccount(username, password) {
    const uname = String(username || '').trim().toLowerCase();
    const pwd = String(password || '');
    const list = readLocalWaliAccounts();
    const acc = list.find(x => String(x.username || '').trim().toLowerCase() === uname);
    if (!acc || !acc.passwordHash || !acc.salt) {
      return { success: false, message: 'Username atau password Wali Santri tidak sesuai.' };
    }
    const candidateHash = await hashPasswordWithSalt(pwd, acc.salt);
    if (!constantTimeEqual(candidateHash, acc.passwordHash)) {
      return { success: false, message: 'Username atau password Wali Santri tidak sesuai.' };
    }
    const defPerms = loadRolePermissions().walisantri || ['rekap'];
    return {
      success: true,
      role: 'walisantri',
      username: acc.username,
      name: acc.namaWali || acc.username,
      namaSantri: acc.namaSantri || '',
      jabatan: acc.namaSantri ? ('Wali • ' + acc.namaSantri) : 'Wali Santri',
      permissions: Array.isArray(acc.akses) ? acc.akses : defPerms
    };
  }

  function verifyWaliSantriCredentials(username, password) {
    return new Promise((resolve) => {
      const uname = String(username || '').trim();
      const pwd = String(password || '');
      if (!uname || !pwd) {
        resolve({ success: false, message: 'Masukkan username dan password terlebih dahulu.' });
        return;
      }

      const fallbackLocal = () => {
        verifyLocalWaliAccount(uname, pwd).then(resolve).catch(() => {
          resolve({ success: false, message: 'Gagal memverifikasi akun Wali Santri.' });
        });
      };

      const hasGas = Boolean(
        navigator.onLine &&
        global.google &&
        global.google.script &&
        global.google.script.run &&
        typeof global.google.script.run.verifyWaliSantriLogin === 'function'
      );

      if (!hasGas) {
        fallbackLocal();
        return;
      }

      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          fallbackLocal();
        }
      }, 8000);

      try {
        global.google.script.run
          .withSuccessHandler(res => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (res && typeof res === 'object' && res.success === true) {
              resolve(res);
              return;
            }
            // Jika server menolak karena endpoint belum tersedia atau belum tersinkron, cek fallback lokal
            const errMsg = String((res && (res.error || res.message)) || '');
            if (errMsg.indexOf('tidak dikenali') !== -1 || errMsg.indexOf('belum tersedia') !== -1) {
              fallbackLocal();
              return;
            }
            // Cek juga apakah akun ada secara lokal (mis. baru dibuat saat offline)
            verifyLocalWaliAccount(uname, pwd).then(localRes => {
              if (localRes && localRes.success) {
                resolve(localRes);
              } else {
                resolve(res && typeof res === 'object' ? res : { success: false, message: 'Username atau password Wali Santri tidak sesuai.' });
              }
            }).catch(() => {
              resolve({ success: false, message: (res && res.message) || 'Username atau password Wali Santri tidak sesuai.' });
            });
          })
          .withFailureHandler(() => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fallbackLocal();
          })
          .verifyWaliSantriLogin(uname, pwd);
      } catch (e) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          fallbackLocal();
        }
      }
    });
  }

  // ===================== 2C. NAVIGASI KATEGORI HEADER (SETELAN ADMIN & STATISTIK) =====================
  function switchAdminCategory(catKey) {
    activeAdminCategory = catKey || 'akses';
    document.querySelectorAll('.admin-cat-panel').forEach(p => {
      p.classList.toggle('hidden', p.id !== 'adminCat_' + activeAdminCategory);
    });
    document.querySelectorAll('.admin-cat-btn').forEach(btn => {
      const isAct = btn.id === 'adminCatBtn_' + activeAdminCategory;
      btn.classList.toggle('bg-indigo-600', isAct);
      btn.classList.toggle('text-white', isAct);
      btn.classList.toggle('shadow-sm', isAct);
      btn.classList.toggle('bg-slate-100', !isAct);
      btn.classList.toggle('dark:bg-slate-800/80', !isAct);
      btn.classList.toggle('text-slate-600', !isAct);
      btn.classList.toggle('dark:text-slate-300', !isAct);
    });

    if (activeAdminCategory === 'akses') {
      switchAdminAksesSub(activeAdminAksesSub);
    } else if (activeAdminCategory === 'absensi') {
      populateDeadlineSettingsForm();
    } else if (activeAdminCategory === 'offline') {
      refreshAdminOfflineQueueUI();
    } else if (activeAdminCategory === 'drive') {
      populateDriveSettingsForm();
      refreshDriveBackupStatus(false);
    }
  }

  function switchAdminAksesSub(subKey) {
    activeAdminAksesSub = subKey || 'walisantri';
    document.querySelectorAll('.admin-akses-sub').forEach(p => {
      p.classList.toggle('hidden', p.id !== 'adminAksesSub_' + activeAdminAksesSub);
    });
    document.querySelectorAll('.admin-akses-sub-btn').forEach(btn => {
      const isAct = btn.id === 'adminAksesSubBtn_' + activeAdminAksesSub;
      btn.classList.toggle('bg-white', isAct);
      btn.classList.toggle('dark:bg-slate-900', isAct);
      btn.classList.toggle('text-indigo-700', isAct);
      btn.classList.toggle('dark:text-indigo-300', isAct);
      btn.classList.toggle('shadow-sm', isAct);
      btn.classList.toggle('text-slate-500', !isAct);
      btn.classList.toggle('dark:text-slate-400', !isAct);
    });

    if (activeAdminAksesSub === 'walisantri') {
      loadWaliSantriAccounts();
    } else if (activeAdminAksesSub === 'pengurus') {
      renderUnifiedPengurusTable();
      if (typeof global.loadUsers === 'function') global.loadUsers();
    } else if (activeAdminAksesSub === 'peran') {
      renderRolePermissionsUI();
    }
  }

  // ===================== 2D. TABEL GABUNGAN PENGURUS (USER + MUSYRIF + PENGAJAR) =====================
  function setPengurusFilter(filterKey) {
    activePengurusFilter = filterKey || 'all';
    document.querySelectorAll('.pengurus-filter-btn').forEach(btn => {
      const isAct = btn.id === 'pengFilterBtn_' + activePengurusFilter;
      btn.classList.toggle('bg-indigo-600', isAct);
      btn.classList.toggle('text-white', isAct);
      btn.classList.toggle('shadow-sm', isAct);
      btn.classList.toggle('bg-slate-100', !isAct);
      btn.classList.toggle('dark:bg-slate-800', !isAct);
      btn.classList.toggle('text-slate-600', !isAct);
      btn.classList.toggle('dark:text-slate-300', !isAct);
    });
    renderUnifiedPengurusTable();
  }

  function renderUnifiedPengurusTable() {
    const tb = document.getElementById('usersTableBody');
    const customUsers = Array.isArray(global.usersCache) ? global.usersCache : [];
    const musyrifs = (global.masterData && Array.isArray(global.masterData.musyrifs)) ? global.masterData.musyrifs : [];
    const pengajars = (global.masterData && Array.isArray(global.masterData.pengajars)) ? global.masterData.pengajars : [];
    const roleCfg = loadRolePermissions();
    const overrides = loadStaffPermissionOverrides();

    const totalAll = customUsers.length + musyrifs.length + pengajars.length;
    const badgeTotal = document.getElementById('badgeCountPengurus');
    if (badgeTotal) badgeTotal.innerText = String(totalAll);

    const setMiniCount = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.innerText = String(val);
    };
    setMiniCount('pengCountAll', totalAll);
    setMiniCount('pengCountCustom', customUsers.length);
    setMiniCount('pengCountMusyrif', musyrifs.length);
    setMiniCount('pengCountPengajar', pengajars.length);

    if (!tb) return;

    const unified = [];
    customUsers.forEach(u => {
      unified.push({
        kind: 'custom',
        id: String(u.id || ''),
        name: String(u.username || ''),
        roleLabel: String(u.jabatan || 'Pengurus'),
        subInfo: u.pin ? ('PIN: ' + String(u.pin)) : 'Pengurus Tambahan',
        badgeCls: 'bg-indigo-50 dark:bg-indigo-950/70 text-indigo-700 dark:text-indigo-300',
        perms: Array.isArray(u.akses) ? u.akses : [],
        isCustomOverride: true
      });
    });

    musyrifs.forEach(m => {
      const nama = String(m.nama || '').trim();
      if (!nama) return;
      const ov = overrides[getStaffOverrideKey('musyrif', nama)];
      unified.push({
        kind: 'musyrif',
        id: nama,
        name: nama,
        roleLabel: 'Musyrif',
        subInfo: m.kamar ? ('Kamar ' + String(m.kamar)) : 'Musyrif Kamar',
        badgeCls: 'bg-sky-50 dark:bg-sky-950/70 text-sky-700 dark:text-sky-300',
        perms: Array.isArray(ov) ? ov : (roleCfg.musyrif || DEFAULT_ROLE_PERMS.musyrif),
        isCustomOverride: Array.isArray(ov)
      });
    });

    pengajars.forEach(p => {
      const nama = String(p.nama || '').trim();
      if (!nama) return;
      const ov = overrides[getStaffOverrideKey('pengajar', nama)];
      const kelasInfo = [p.kelas, p.qismu].filter(Boolean).join(' • ');
      unified.push({
        kind: 'pengajar',
        id: nama,
        name: nama,
        roleLabel: 'Pengajar',
        subInfo: kelasInfo || 'Pengajar Takhassus',
        badgeCls: 'bg-teal-50 dark:bg-teal-950/70 text-teal-700 dark:text-teal-300',
        perms: Array.isArray(ov) ? ov : (roleCfg.pengajar || DEFAULT_ROLE_PERMS.pengajar),
        isCustomOverride: Array.isArray(ov)
      });
    });

    const q = (document.getElementById('pengurusSearchInput')?.value || '').trim().toLowerCase();
    const filtered = unified.filter(item => {
      if (activePengurusFilter !== 'all' && item.kind !== activePengurusFilter) return false;
      if (!q) return true;
      return item.name.toLowerCase().includes(q) ||
        item.roleLabel.toLowerCase().includes(q) ||
        item.subInfo.toLowerCase().includes(q);
    });

    if (!filtered.length) {
      tb.innerHTML = '<tr><td colspan="4" class="p-6 text-center text-slate-400 text-xs">Tidak ada data pengurus / musyrif / pengajar yang cocok.</td></tr>';
      return;
    }

    tb.innerHTML = filtered.map(item => {
      const permChips = (item.perms || []).map(a =>
        `<span class="px-2 py-0.5 rounded bg-blue-50 dark:bg-blue-950/70 text-blue-700 dark:text-blue-300 text-[10px] font-semibold">${escHtml(getPermLabel(a))}</span>`
      ).join('') || '<span class="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 text-[10px] font-semibold">Beranda</span>';

      const statusTag = item.kind !== 'custom'
        ? (item.isCustomOverride
          ? '<span class="ml-1 px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-950/70 text-amber-700 dark:text-amber-300 text-[9px] font-bold">Khusus</span>'
          : '<span class="ml-1 px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 text-[9px] font-semibold">Default Peran</span>')
        : '';

      const safeId = escJsInAttr(item.id);
      const safeSub = escJsInAttr(item.subInfo);
      const actionsHtml = item.kind === 'custom'
        ? `<button type="button" onclick="openUserModal('${safeId}')" class="w-8 h-8 rounded-lg bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-400 hover:bg-blue-100 inline-flex items-center justify-center mr-1" title="Edit User"><i class="fa-solid fa-pen text-[11px]"></i></button>
           <button type="button" onclick="delUser('${safeId}')" class="w-8 h-8 rounded-lg bg-red-50 dark:bg-red-950/60 text-red-600 dark:text-red-400 hover:bg-red-100 inline-flex items-center justify-center" title="Hapus User"><i class="fa-solid fa-trash text-[11px]"></i></button>`
        : `<button type="button" onclick="window.AlRifaieAdminSettings.openStaffPermModal('${item.kind}', '${safeId}', '${safeSub}')" class="px-2.5 py-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-950/70 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 text-[11px] font-bold inline-flex items-center gap-1" title="Atur Hak Akses"><i class="fa-solid fa-sliders text-[10px]"></i><span>Atur Akses</span></button>`;

      return `<tr class="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 transition-colors">
        <td class="p-3">
          <div class="font-bold text-slate-900 dark:text-white text-xs">${escHtml(item.name)}</div>
          <div class="text-[10px] text-slate-500 mt-0.5">${escHtml(item.subInfo)}</div>
        </td>
        <td class="p-3 whitespace-nowrap">
          <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${item.badgeCls}">${escHtml(item.roleLabel)}</span>${statusTag}
        </td>
        <td class="p-3"><div class="flex flex-wrap gap-1">${permChips}</div></td>
        <td class="p-3 text-center whitespace-nowrap">${actionsHtml}</td>
      </tr>`;
    }).join('');
  }

  function openStaffPermModal(role, name, detailText) {
    const roleEl = document.getElementById('spRole');
    const nameEl = document.getElementById('spName');
    const titleEl = document.getElementById('staffPermModalTitle');
    const subEl = document.getElementById('staffPermModalSub');
    const resetBtn = document.getElementById('btnResetStaffPermDefault');

    const cleanRole = role === 'pengajar' ? 'pengajar' : 'musyrif';
    const cleanName = String(name || '').trim();
    if (!cleanName) return;

    if (roleEl) roleEl.value = cleanRole;
    if (nameEl) nameEl.value = cleanName;
    if (titleEl) titleEl.innerText = 'Hak Akses ' + (cleanRole === 'musyrif' ? 'Musyrif' : 'Pengajar');
    if (subEl) subEl.innerText = cleanName + (detailText ? (' • ' + detailText) : '');

    const overrides = loadStaffPermissionOverrides();
    const key = getStaffOverrideKey(cleanRole, cleanName);
    const hasCustom = Array.isArray(overrides[key]);
    const roleCfg = loadRolePermissions();
    const activePerms = hasCustom
      ? overrides[key]
      : (cleanRole === 'musyrif' ? (roleCfg.musyrif || DEFAULT_ROLE_PERMS.musyrif) : (roleCfg.pengajar || DEFAULT_ROLE_PERMS.pengajar));

    if (resetBtn) resetBtn.classList.toggle('hidden', !hasCustom);
    document.querySelectorAll('input[name="spPerm"]').forEach(c => {
      c.checked = activePerms.includes(c.value);
    });

    if (typeof global.openModal === 'function') global.openModal('staffPermModal');
  }

  function saveStaffPermAction(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    const role = (document.getElementById('spRole')?.value || '').trim();
    const name = (document.getElementById('spName')?.value || '').trim();
    if (!role || !name) return;

    const allowedKeys = ALL_PERMISSIONS.map(p => p.key);
    const selected = Array.from(document.querySelectorAll('input[name="spPerm"]:checked'))
      .map(c => c.value)
      .filter(k => allowedKeys.includes(k));

    if (!selected.length) {
      if (typeof global.Swal !== 'undefined') global.Swal.fire('Perhatian', 'Pilih minimal 1 hak akses fitur.', 'warning');
      return;
    }

    const overrides = loadStaffPermissionOverrides();
    overrides[getStaffOverrideKey(role, name)] = selected;
    saveStaffPermissionOverridesLocal(overrides);
    if (global.appSettings && typeof global.appSettings === 'object') {
      global.appSettings.staffPermissionOverrides = overrides;
    }
    if (typeof global.closeModal === 'function') global.closeModal('staffPermModal');
    renderUnifiedPengurusTable();

    if (global.session && global.session.role === role && String(global.session.name || '').trim().toLowerCase() === name.toLowerCase()) {
      global.session.permissions = selected;
      if (typeof global.refreshPermissionsUI === 'function') global.refreshPermissionsUI();
    }

    syncExtraSettingsToServer({ staffPermissionOverrides: overrides }, 'Hak akses khusus untuk ' + name + ' berhasil disimpan.');
  }

  function resetStaffPermToDefault() {
    const role = (document.getElementById('spRole')?.value || '').trim();
    const name = (document.getElementById('spName')?.value || '').trim();
    if (!role || !name) return;

    const overrides = loadStaffPermissionOverrides();
    delete overrides[getStaffOverrideKey(role, name)];
    saveStaffPermissionOverridesLocal(overrides);
    if (global.appSettings && typeof global.appSettings === 'object') {
      global.appSettings.staffPermissionOverrides = overrides;
    }
    if (typeof global.closeModal === 'function') global.closeModal('staffPermModal');
    renderUnifiedPengurusTable();
    syncExtraSettingsToServer({ staffPermissionOverrides: overrides }, 'Hak akses ' + name + ' dikembalikan ke default peran.');
  }

  function switchRekapCategory(catKey) {
    let nextCat = catKey || 'ringkasan';
    if (nextCat === 'suratdisiplin' && (!global.session || global.session.role !== 'admin')) {
      nextCat = 'ringkasan';
    }
    activeRekapCategory = nextCat;
    document.querySelectorAll('.rekap-cat-panel').forEach(p => {
      p.classList.toggle('hidden', p.id !== 'rekapCat_' + activeRekapCategory);
    });
    document.querySelectorAll('.rekap-cat-btn').forEach(btn => {
      const isAct = btn.id === 'rekapCatBtn_' + activeRekapCategory;
      btn.classList.toggle('bg-indigo-600', isAct);
      btn.classList.toggle('text-white', isAct);
      btn.classList.toggle('shadow-sm', isAct);
      btn.classList.toggle('bg-slate-100', !isAct);
      btn.classList.toggle('dark:bg-slate-800/80', !isAct);
      btn.classList.toggle('text-slate-600', !isAct);
      btn.classList.toggle('dark:text-slate-300', !isAct);
    });

    if (activeRekapCategory === 'ringkasan') {
      requestAnimationFrame(() => {
        if (global.__lastRekapChartData && typeof global.drawChart === 'function') {
          global.drawChart(global.__lastRekapChartData);
        } else if (global.rekapChartInst && typeof global.rekapChartInst.resize === 'function') {
          global.rekapChartInst.resize();
        }
      });
    } else if (activeRekapCategory === 'suratdisiplin') {
      if (global.AlRifaieSmart && typeof global.AlRifaieSmart.renderSuratDisiplinPanel === 'function') {
        global.AlRifaieSmart.renderSuratDisiplinPanel();
      }
    }
  }

  function syncExtraSettingsToServer(partialExtra, successText) {
    const baseSettings = Object.assign({}, global.appSettings || {}, partialExtra);
    if (!baseSettings.appName) {
      baseSettings.appName = document.getElementById('setAppName')?.value || 'Departemen Pendidikan';
    }
    try {
      if (global.google && global.google.script && global.google.script.run && typeof global.google.script.run.updateAppSettings === 'function') {
        global.google.script.run
          .withSuccessHandler(() => {
            if (typeof global.Swal !== 'undefined') {
              global.Swal.fire('Tersimpan', successText, 'success');
            }
          })
          .withFailureHandler(() => {
            if (typeof global.Swal !== 'undefined') {
              global.Swal.fire('Tersimpan Lokal', successText + ' (Akan disinkronkan ke server saat online).', 'info');
            }
          })
          .updateAppSettings(baseSettings);
        return;
      }
    } catch (err) {}

    if (typeof global.Swal !== 'undefined') {
      global.Swal.fire('Tersimpan', successText, 'success');
    }
  }

  // ===================== 3. PANTAUAN DATA OFFLINE MANGKRAK (ADMIN) & NOTIFIKASI LATAR BELAKANG =====================
  function formatTimeMs(ms) {
    if (!ms) return '-';
    try {
      const d = new Date(Number(ms));
      return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' }) + ' ' +
        d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return '-';
    }
  }

  function refreshAdminOfflineQueueUI(overrideList) {
    let list = Array.isArray(overrideList) ? overrideList : null;
    if (!list) {
      try {
        if (global.AndroidBridge && typeof global.AndroidBridge.getPendingOfflineQueueJson === 'function') {
          const raw = global.AndroidBridge.getPendingOfflineQueueJson();
          list = raw ? JSON.parse(raw) : [];
        } else {
          list = [];
        }
      } catch (e) {
        list = [];
      }
    }
    cachedOfflineQueue = Array.isArray(list) ? list : [];

    // Sync toggles state from native AndroidBridge
    const autoToggle = document.getElementById('adminAutoUploadOfflineToggle');
    if (autoToggle && global.AndroidBridge && typeof global.AndroidBridge.isAutoUploadOfflineEnabled === 'function') {
      try { autoToggle.checked = Boolean(global.AndroidBridge.isAutoUploadOfflineEnabled()); } catch (e) {}
    }
    const bgNotifToggle = document.getElementById('adminBgNotifToggle');
    if (bgNotifToggle && global.AndroidBridge && typeof global.AndroidBridge.isBackgroundNotifEnabled === 'function') {
      try { bgNotifToggle.checked = Boolean(global.AndroidBridge.isBackgroundNotifEnabled()); } catch (e) {}
    }

    const badgeCount = document.getElementById('adminOfflineCountBadge');
    const container = document.getElementById('adminOfflineQueueList');
    const uploadAllBtn = document.getElementById('btnAdminUploadAllOffline');

    const total = cachedOfflineQueue.length;
    const failedCount = cachedOfflineQueue.filter(x => x.status === 'FAILED' || (Number(x.retryCount) || 0) > 0).length;

    if (badgeCount) {
      if (total === 0) {
        badgeCount.className = 'px-2.5 py-1 rounded-full text-[11px] font-bold bg-emerald-100 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-300';
        badgeCount.innerText = 'Semua Tersinkron (0)';
      } else {
        badgeCount.className = 'px-2.5 py-1 rounded-full text-[11px] font-bold bg-amber-100 dark:bg-amber-950/70 text-amber-800 dark:text-amber-300';
        badgeCount.innerText = total + ' Antrean' + (failedCount > 0 ? ' (' + failedCount + ' Mangkrak)' : '');
      }
    }

    const catOfflineDot = document.getElementById('adminCatOfflineDot');
    if (catOfflineDot) {
      catOfflineDot.classList.toggle('hidden', total === 0);
      catOfflineDot.innerText = total > 99 ? '99+' : String(total);
    }

    if (uploadAllBtn) {
      uploadAllBtn.disabled = total === 0;
      uploadAllBtn.classList.toggle('opacity-50', total === 0);
    }

    if (!container) return;

    if (!global.AndroidBridge) {
      container.innerHTML = '<div class="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/50 text-center text-xs text-slate-500">Antrean penyimpanan offline lokal aktif di aplikasi APK Android.</div>';
      return;
    }

    if (total === 0) {
      container.innerHTML = '<div class="p-5 rounded-xl bg-emerald-50/60 dark:bg-emerald-950/25 border border-emerald-200/60 dark:border-emerald-800/50 text-center text-xs font-semibold text-emerald-700 dark:text-emerald-300"><i class="fa-solid fa-cloud-check mr-1.5"></i>Tidak ada data offline yang mangkrak. Seluruh data sudah masuk ke Google Sheet.</div>';
      return;
    }

    container.innerHTML = cachedOfflineQueue.map(op => {
      const isFailed = op.status === 'FAILED';
      const isSyncing = op.status === 'SYNCING';
      const statusBadge = isSyncing
        ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-100 text-blue-700">Mengunggah...</span>'
        : (isFailed
          ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-100 text-red-700">Mangkrak / Gagal (' + (op.retryCount || 1) + 'x)</span>'
          : '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800">Menunggu</span>');

      const senderText = op.petugas ? (' • Petugas: ' + escHtml(op.petugas)) : '';
      const errHtml = op.lastError ? `<div class="text-[10px] text-red-600 dark:text-red-400 mt-0.5 truncate"><i class="fa-solid fa-circle-exclamation mr-1"></i>${escHtml(op.lastError)}</div>` : '';
      const safeId = escHtml(op.clientOpId).replace(/'/g, "\\'");

      return `<div class="p-3 rounded-xl border ${isFailed ? 'border-red-200 dark:border-red-900/70 bg-red-50/40 dark:bg-red-950/20' : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900/50'} flex items-center justify-between gap-2.5">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="text-xs font-bold text-slate-800 dark:text-slate-100 truncate">${escHtml(op.summaryLabel || op.fnName)}</span>
            ${statusBadge}
          </div>
          <div class="text-[10px] text-slate-500 mt-0.5">${formatTimeMs(op.createdAt)}${senderText}</div>
          ${errHtml}
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <button type="button" onclick="window.AlRifaieAdminSettings.retrySingleOffline('${safeId}')" class="px-2.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-bold inline-flex items-center gap-1" title="Unggah Manual"><i class="fa-solid fa-cloud-arrow-up"></i><span>Unggah</span></button>
          <button type="button" onclick="window.AlRifaieAdminSettings.deleteOfflineItem('${safeId}')" class="w-8 h-8 rounded-lg bg-red-50 dark:bg-red-950/60 text-red-600 dark:text-red-400 hover:bg-red-100 inline-flex items-center justify-center" title="Hapus Antrean"><i class="fa-solid fa-trash text-[11px]"></i></button>
        </div>
      </div>`;
    }).join('');
  }

  function toggleAutoUploadOffline(checked) {
    try {
      if (global.AndroidBridge && typeof global.AndroidBridge.setAutoUploadOfflineEnabled === 'function') {
        global.AndroidBridge.setAutoUploadOfflineEnabled(Boolean(checked));
      }
    } catch (e) {}
    if (typeof global.Swal !== 'undefined') {
      global.Swal.fire({
        toast: true,
        position: 'top',
        icon: 'success',
        title: checked ? 'Unggah otomatis saat online diaktifkan' : 'Mode unggah manual diaktifkan',
        showConfirmButton: false,
        timer: 2000
      });
    }
  }

  function toggleBackgroundNotif(checked) {
    try {
      if (global.AndroidBridge && typeof global.AndroidBridge.setBackgroundNotifEnabled === 'function') {
        global.AndroidBridge.setBackgroundNotifEnabled(Boolean(checked));
      }
    } catch (e) {}
    if (typeof global.Swal !== 'undefined') {
      global.Swal.fire({
        toast: true,
        position: 'top',
        icon: 'success',
        title: checked ? 'Notifikasi saat aplikasi tertutup aktif' : 'Notifikasi latar belakang dijeda',
        showConfirmButton: false,
        timer: 2000
      });
    }
  }

  function uploadAllOfflineManual() {
    if (!global.AndroidBridge || typeof global.AndroidBridge.requestManualSync !== 'function') return;
    global.AndroidBridge.requestManualSync();
    setTimeout(() => refreshAdminOfflineQueueUI(), 900);
  }

  function retrySingleOffline(clientOpId) {
    if (!clientOpId || !global.AndroidBridge || typeof global.AndroidBridge.retrySingleOfflineOp !== 'function') return;
    global.AndroidBridge.retrySingleOfflineOp(clientOpId);
    setTimeout(() => refreshAdminOfflineQueueUI(), 900);
  }

  function deleteOfflineItem(clientOpId) {
    if (!clientOpId) return;
    const doDel = () => {
      if (global.AndroidBridge && typeof global.AndroidBridge.deleteOfflineOp === 'function') {
        global.AndroidBridge.deleteOfflineOp(clientOpId);
      }
      setTimeout(() => refreshAdminOfflineQueueUI(), 350);
    };
    if (typeof global.Swal !== 'undefined') {
      global.Swal.fire({
        title: 'Hapus Antrean Offline?',
        text: 'Data lokal ini akan dihapus dari antrean unggah perangkat.',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#DC2626',
        confirmButtonText: 'Ya, Hapus',
        cancelButtonText: 'Batal'
      }).then(r => { if (r.isConfirmed) doDel(); });
    } else {
      doDel();
    }
  }

  function triggerBackgroundCheckNow() {
    if (global.AndroidBridge && typeof global.AndroidBridge.triggerBackgroundCheckNow === 'function') {
      global.AndroidBridge.triggerBackgroundCheckNow();
    }
    if (typeof global.Swal !== 'undefined') {
      global.Swal.fire({
        toast: true,
        position: 'top',
        icon: 'info',
        title: 'Pemeriksaan notifikasi & sinkronisasi latar belakang dijadwalkan',
        showConfirmButton: false,
        timer: 2200
      });
    }
  }

  // ===================== 4. INTEGRASI CADANGAN GOOGLE DRIVE =====================
  function loadDriveConfig() {
    try {
      const raw = localStorage.getItem(DRIVE_CONFIG_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return Object.assign({}, DEFAULT_DRIVE_CONFIG, parsed || {});
    } catch (e) {
      return Object.assign({}, DEFAULT_DRIVE_CONFIG);
    }
  }

  function saveDriveConfigLocal(cfg) {
    try {
      localStorage.setItem(DRIVE_CONFIG_KEY, JSON.stringify(Object.assign({}, DEFAULT_DRIVE_CONFIG, cfg || {})));
    } catch (e) {}
  }

  function populateDriveSettingsForm() {
    const cfg = loadDriveConfig();
    const enEl = document.getElementById('driveBackupEnabled');
    const galEl = document.getElementById('driveBackupGaleri');
    const surEl = document.getElementById('driveBackupSurat');
    const fidEl = document.getElementById('driveRootFolderId');
    const fnameEl = document.getElementById('driveRootFolderName');
    if (enEl) enEl.checked = Boolean(cfg.enabled);
    if (galEl) galEl.checked = Boolean(cfg.backupGaleri);
    if (surEl) surEl.checked = Boolean(cfg.backupSurat);
    if (fidEl) fidEl.value = cfg.rootFolderId || '';
    if (fnameEl) fnameEl.value = cfg.rootFolderName || DEFAULT_DRIVE_CONFIG.rootFolderName;
  }

  function renderDriveStatusUI(res) {
    const badge = document.getElementById('driveStatusBadge');
    const statsWrap = document.getElementById('driveStatsContainer');
    const galCountEl = document.getElementById('driveStatGaleriCount');
    const surCountEl = document.getElementById('driveStatSuratCount');
    const folderLinkEl = document.getElementById('driveRootFolderLink');
    const galLinkEl = document.getElementById('driveGaleriFolderLink');
    const surLinkEl = document.getElementById('driveSuratFolderLink');

    if (res && res.connected) {
      if (badge) {
        badge.className = 'px-2.5 py-1 rounded-full text-[10.5px] font-bold bg-emerald-100 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-300 inline-flex items-center gap-1';
        badge.innerHTML = '<i class="fa-solid fa-circle-check text-[10px]"></i><span>Terhubung ke Google Drive</span>';
      }
      if (statsWrap) statsWrap.classList.remove('hidden');
      if (galCountEl) galCountEl.innerText = String(res.galeriCount || 0) + ' Foto';
      if (surCountEl) surCountEl.innerText = String(res.suratCount || 0) + ' Berkas';
      if (folderLinkEl && res.rootFolderUrl) {
        folderLinkEl.href = res.rootFolderUrl;
        folderLinkEl.classList.remove('hidden');
      }
      if (galLinkEl && res.galeriFolderUrl) galLinkEl.href = res.galeriFolderUrl;
      if (surLinkEl && res.suratFolderUrl) surLinkEl.href = res.suratFolderUrl;
    } else {
      if (badge) {
        badge.className = 'px-2.5 py-1 rounded-full text-[10.5px] font-bold bg-amber-100 dark:bg-amber-950/70 text-amber-800 dark:text-amber-300 inline-flex items-center gap-1';
        badge.innerHTML = '<i class="fa-solid fa-cloud text-[10px]"></i><span>Siap (Perbarui Apps Script jika belum aktif)</span>';
      }
    }
  }

  function refreshDriveBackupStatus(showToast) {
    const badge = document.getElementById('driveStatusBadge');
    if (badge) {
      badge.className = 'px-2.5 py-1 rounded-full text-[10.5px] font-bold bg-indigo-50 dark:bg-indigo-950/70 text-indigo-600 dark:text-indigo-300 inline-flex items-center gap-1';
      badge.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-[10px]"></i><span>Memeriksa Google Drive...</span>';
    }
    try {
      if (global.google && global.google.script && global.google.script.run && typeof global.google.script.run.getDriveBackupStatus === 'function') {
        global.google.script.run
          .withSuccessHandler(res => {
            if (res && res.config) {
              saveDriveConfigLocal(res.config);
              populateDriveSettingsForm();
            }
            renderDriveStatusUI(res);
            if (showToast && typeof global.Swal !== 'undefined') {
              if (res && res.connected) {
                global.Swal.fire('Google Drive Aktif', `Folder "${res.rootFolderName}" siap mencadangkan foto Galeri Santri (${res.galeriCount || 0}) & Arsip Surat (${res.suratCount || 0}) otomatis.`, 'success');
              } else {
                global.Swal.fire('Info Integrasi Drive', (res && res.error) || 'Pastikan kode Apps Script terbaru sudah di-deploy dengan izin DriveApp.', 'info');
              }
            }
          })
          .withFailureHandler(() => {
            renderDriveStatusUI(null);
            if (showToast && typeof global.Swal !== 'undefined') {
              global.Swal.fire('Belum Terhubung', 'Gagal memeriksa status Google Drive. Periksa koneksi atau deploy ulang Apps Script.', 'warning');
            }
          })
          .getDriveBackupStatus();
        return;
      }
    } catch (e) {}
    renderDriveStatusUI(null);
  }

  function saveDriveConfigAction(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    const cfg = {
      enabled: Boolean(document.getElementById('driveBackupEnabled')?.checked),
      backupGaleri: Boolean(document.getElementById('driveBackupGaleri')?.checked),
      backupSurat: Boolean(document.getElementById('driveBackupSurat')?.checked),
      rootFolderId: (document.getElementById('driveRootFolderId')?.value || '').trim(),
      rootFolderName: (document.getElementById('driveRootFolderName')?.value || '').trim() || DEFAULT_DRIVE_CONFIG.rootFolderName
    };
    saveDriveConfigLocal(cfg);
    if (global.appSettings && typeof global.appSettings === 'object') {
      global.appSettings.driveConfig = cfg;
    }

    try {
      if (global.google && global.google.script && global.google.script.run && typeof global.google.script.run.saveDriveBackupConfig === 'function') {
        global.google.script.run
          .withSuccessHandler(res => {
            renderDriveStatusUI(res);
            if (typeof global.Swal !== 'undefined') {
              global.Swal.fire('Tersimpan', 'Konfigurasi cadangan otomatis Google Drive berhasil disimpan.', 'success');
            }
          })
          .withFailureHandler(() => {
            syncExtraSettingsToServer({ driveConfig: cfg }, 'Konfigurasi Google Drive tersimpan.');
          })
          .saveDriveBackupConfig(cfg);
        return;
      }
    } catch (err) {}
    syncExtraSettingsToServer({ driveConfig: cfg }, 'Konfigurasi Google Drive tersimpan.');
  }

  function onSettingsFromServer(settingsObj) {
    if (!settingsObj || typeof settingsObj !== 'object') return;
    if (settingsObj.attendanceDeadlines && typeof settingsObj.attendanceDeadlines === 'object') {
      saveDeadlinesLocal(settingsObj.attendanceDeadlines);
      populateDeadlineSettingsForm();
      renderDeadlineBadges();
    }
    if (settingsObj.rolePermissions && typeof settingsObj.rolePermissions === 'object') {
      saveRolePermissionsLocal(settingsObj.rolePermissions);
      renderRolePermissionsUI();
    }
    if (settingsObj.staffPermissionOverrides && typeof settingsObj.staffPermissionOverrides === 'object') {
      saveStaffPermissionOverridesLocal(settingsObj.staffPermissionOverrides);
    }
    if (settingsObj.driveConfig && typeof settingsObj.driveConfig === 'object') {
      saveDriveConfigLocal(settingsObj.driveConfig);
      populateDriveSettingsForm();
    }
    renderUnifiedPengurusTable();
  }

  function onAdminTabOpened() {
    populateDeadlineSettingsForm();
    populateDriveSettingsForm();
    renderRolePermissionsUI();
    loadWaliSantriAccounts();
    renderUnifiedPengurusTable();
    refreshAdminOfflineQueueUI();
    switchAdminCategory(activeAdminCategory);
  }

  global.__androidOnOfflineQueueChanged = function (queueJson) {
    try {
      const parsed = typeof queueJson === 'string' ? JSON.parse(queueJson) : queueJson;
      refreshAdminOfflineQueueUI(parsed);
    } catch (e) {
      refreshAdminOfflineQueueUI();
    }
  };

  global.AlRifaieAdminSettings = {
    loadDeadlines: loadDeadlines,
    evaluateDeadline: evaluateDeadline,
    evaluateIzinDeadline: evaluateIzinDeadline,
    renderDeadlineBadges: renderDeadlineBadges,
    populateDeadlineSettingsForm: populateDeadlineSettingsForm,
    saveAttendanceDeadlines: saveAttendanceDeadlines,
    loadDriveConfig: loadDriveConfig,
    populateDriveSettingsForm: populateDriveSettingsForm,
    refreshDriveBackupStatus: refreshDriveBackupStatus,
    saveDriveConfigAction: saveDriveConfigAction,
    loadRolePermissions: loadRolePermissions,
    loadStaffPermissionOverrides: loadStaffPermissionOverrides,
    getEffectivePermissionsForSession: getEffectivePermissionsForSession,
    renderRolePermissionsUI: renderRolePermissionsUI,
    saveRolePermissions: saveRolePermissions,
    setPengurusFilter: setPengurusFilter,
    renderUnifiedPengurusTable: renderUnifiedPengurusTable,
    openStaffPermModal: openStaffPermModal,
    saveStaffPermAction: saveStaffPermAction,
    resetStaffPermToDefault: resetStaffPermToDefault,
    loadWaliSantriAccounts: loadWaliSantriAccounts,
    renderWaliSantriTable: renderWaliSantriTable,
    saveSharedWaliAccount: saveSharedWaliAccount,
    openWaliModal: openWaliModal,
    saveWaliSantriAction: saveWaliSantriAction,
    deleteWaliSantri: deleteWaliSantri,
    verifyWaliSantriCredentials: verifyWaliSantriCredentials,
    switchAdminCategory: switchAdminCategory,
    switchAdminAksesSub: switchAdminAksesSub,
    switchRekapCategory: switchRekapCategory,
    refreshAdminOfflineQueueUI: refreshAdminOfflineQueueUI,
    toggleAutoUploadOffline: toggleAutoUploadOffline,
    toggleBackgroundNotif: toggleBackgroundNotif,
    uploadAllOfflineManual: uploadAllOfflineManual,
    retrySingleOffline: retrySingleOffline,
    deleteOfflineItem: deleteOfflineItem,
    triggerBackgroundCheckNow: triggerBackgroundCheckNow,
    onSettingsFromServer: onSettingsFromServer,
    onAdminTabOpened: onAdminTabOpened
  };

  setTimeout(() => {
    renderDeadlineBadges();
    populateDeadlineSettingsForm();
    populateDriveSettingsForm();
    renderRolePermissionsUI();
    renderWaliSantriTable();
    renderUnifiedPengurusTable();
    switchAdminCategory(activeAdminCategory);
    switchRekapCategory(activeRekapCategory);
  }, 500);
  // Refresh badge batas waktu setiap 60 detik
  setInterval(renderDeadlineBadges, 60000);
})(window);
