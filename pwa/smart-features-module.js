/**
 * =========================================================================
 * MODUL FITUR PINTAR & SOFT BENTO DASHBOARD ADAPTIF PERAN
 * Departemen Pendidikan - YPM Al-Rifa'ie 2
 * =========================================================================
 * Mencakup:
 * 1. Reusable One-Handed Bottom Sheet (.clean-bottom-sheet)
 * 2. Beranda Adaptif Peran (Wali Santri, Musyrif/Pengajar + Peringatan Santri Bermasalah, Admin Monitor Belum Absen)
 * 3. Izin Digital (Sakit / Pulang / Dispensasi) + Persetujuan Pengurus + Auto-Sync Absensi
 * 4. Cetak Surat Pernyataan & Surat Hukuman (Daftar Alpa Santri & Musyrif + Checkbox + PDF Berkop Resmi)
 * 5. Ekspor Laporan Rekap Resmi Berkop PDF & Pengingat 10 Menit Sebelum Batas Waktu Absen
 */
(function (global) {
  'use strict';

  const IZIN_STORAGE_KEY = 'alrifaie_izin_digital_v1';
  const TINDAKAN_STORAGE_KEY = 'alrifaie_santri_tindakan_v1';
  const REMINDER_SENT_KEY = 'alrifaie_deadline_reminder_sent_v1';

  let izinListCache = [];
  let tindakanListCache = [];
  let activeIzinFilter = 'all';
  let suratTargetMode = 'santri'; // 'santri' | 'musyrif'
  let suratDocType = 'pernyataan'; // 'pernyataan' | 'hukuman'
  let suratCheckedSet = new Set();
  let suratLastRows = [];
  let cachedMissingToday = null;
  let bentoDataLoading = false;
  let lastBentoLoadedRoleKey = '';
  let countdownIntervalId = null;

  // ===================== UTILITAS AMAN =====================
  function escHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escJsAttr(str) {
    return escHtml(
      String(str == null ? '' : str)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\r|\n/g, ' ')
    );
  }

  function normText(str) {
    return String(str || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function getTodayWib() {
    if (typeof global.getWIBDateString === 'function') return global.getWIBDateString();
    const n = new Date();
    const w = new Date(n.getTime() + n.getTimezoneOffset() * 60000 + 25200000);
    return `${w.getFullYear()}-${String(w.getMonth() + 1).padStart(2, '0')}-${String(w.getDate()).padStart(2, '0')}`;
  }

  function getWibNowMinutes() {
    const n = new Date();
    const w = new Date(n.getTime() + n.getTimezoneOffset() * 60000 + 25200000);
    return {
      hours: w.getHours(),
      minutes: w.getMinutes(),
      seconds: w.getSeconds(),
      totalMin: w.getHours() * 60 + w.getMinutes()
    };
  }

  function formatIndoDate(dateStr) {
    if (!dateStr) return '-';
    const p = String(dateStr).slice(0, 10).split('-');
    if (p.length !== 3) return dateStr;
    const months = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
    const mIdx = parseInt(p[1], 10) - 1;
    return `${parseInt(p[2], 10)} ${months[mIdx] || p[1]} ${p[0]}`;
  }

  function canApproveIzin() {
    const sess = global.session;
    return Boolean(sess && sess.role === 'admin');
  }

  function hasAccessIzin() {
    const sess = global.session;
    if (!sess) return false;
    if (sess.role === 'admin') return true;
    if (sess.role === 'walisantri') return false;
    return typeof global.hasPerm === 'function' ? global.hasPerm('izin') : (sess.role === 'musyrif' || sess.role === 'pengajar');
  }

  function canSubmitIzin() {
    const sess = global.session;
    if (!sess || !hasAccessIzin()) return false;
    return sess.role === 'musyrif' || sess.role === 'pengajar' || sess.role === 'admin';
  }

  function normalizeTargetToken(str) {
    return normText(str).replace(/^(kamar|kelas)\s+/i, '').trim();
  }

  function targetMatchesAny(rawTarget, targets) {
    if (!rawTarget || !Array.isArray(targets) || !targets.length) return false;
    const rtNorm = normText(rawTarget);
    const rtToken = normalizeTargetToken(rawTarget);
    if (!rtNorm) return false;
    return targets.some(t => {
      const tNorm = normText(t);
      const tToken = normalizeTargetToken(t);
      if (!tNorm) return false;
      return rtNorm === tNorm || (rtToken && tToken && rtToken === tToken);
    });
  }

  // ===================== 1. REUSABLE ONE-HANDED BOTTOM SHEET =====================
  function openBottomSheet(title, subtitle, bodyHtml, footerHtml) {
    const backdrop = document.getElementById('smartBottomSheetBackdrop');
    const sheet = document.getElementById('smartBottomSheet');
    const titleEl = document.getElementById('smartSheetTitle');
    const subEl = document.getElementById('smartSheetSub');
    const bodyEl = document.getElementById('smartSheetBody');
    const footEl = document.getElementById('smartSheetFooter');
    if (!backdrop || !sheet) return;

    if (titleEl) titleEl.innerText = title || 'Detail';
    if (subEl) {
      subEl.innerText = subtitle || '';
      subEl.classList.toggle('hidden', !subtitle);
    }
    if (bodyEl) bodyEl.innerHTML = bodyHtml || '';
    if (footEl) {
      footEl.innerHTML = footerHtml || '';
      footEl.classList.toggle('hidden', !footerHtml);
    }

    backdrop.classList.remove('hidden');
    sheet.classList.remove('hidden');
    void sheet.offsetWidth;
    backdrop.classList.add('backdrop-visible');
    sheet.classList.add('sheet-open');
    document.body.style.overflow = 'hidden';
  }

  function closeBottomSheet() {
    const backdrop = document.getElementById('smartBottomSheetBackdrop');
    const sheet = document.getElementById('smartBottomSheet');
    if (!sheet || !backdrop) return;
    sheet.classList.remove('sheet-open');
    backdrop.classList.remove('backdrop-visible');
    setTimeout(() => {
      if (!sheet.classList.contains('sheet-open')) {
        sheet.classList.add('hidden');
        backdrop.classList.add('hidden');
      }
      const anyModalOpen = document.querySelector('.modal-backdrop-clean.modal-is-open');
      if (!anyModalOpen) {
        document.body.style.overflow = '';
      }
    }, 240);
  }

  function isBottomSheetOpen() {
    const sheet = document.getElementById('smartBottomSheet');
    return Boolean(sheet && sheet.classList.contains('sheet-open') && !sheet.classList.contains('hidden'));
  }

  // ===================== 2. STORAGE LOKAL & SINKRONISASI IZIN + TINDAKAN =====================
  function readLocalIzin() {
    try {
      const raw = localStorage.getItem(IZIN_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function writeLocalIzin(list) {
    izinListCache = Array.isArray(list) ? list : [];
    try {
      localStorage.setItem(IZIN_STORAGE_KEY, JSON.stringify(izinListCache));
    } catch (e) {}
  }

  function readLocalTindakan() {
    try {
      const raw = localStorage.getItem(TINDAKAN_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function writeLocalTindakan(list) {
    tindakanListCache = Array.isArray(list) ? list : [];
    try {
      localStorage.setItem(TINDAKAN_STORAGE_KEY, JSON.stringify(tindakanListCache));
    } catch (e) {}
  }

  function loadIzinDigital(forceRefresh) {
    if (!izinListCache.length) izinListCache = readLocalIzin();
    renderIzinDigitalUI();
    try {
      if (global.google && global.google.script && global.google.script.run && typeof global.google.script.run.getIzinDigital === 'function') {
        global.google.script.run
          .withSuccessHandler(serverList => {
            if (!Array.isArray(serverList)) return;
            const localUnsynced = readLocalIzin().filter(x => x.localOnly);
            const serverIds = new Set(serverList.map(x => String(x.id)));
            const merged = serverList.concat(localUnsynced.filter(x => !serverIds.has(String(x.id))));
            writeLocalIzin(merged);
            renderIzinDigitalUI();
            renderRoleBentoDashboard();
          })
          .withFailureHandler(() => {})
          .getIzinDigital();
      }
    } catch (e) {}
  }

  function loadSantriTindakan() {
    if (!tindakanListCache.length) tindakanListCache = readLocalTindakan();
    try {
      if (global.google && global.google.script && global.google.script.run && typeof global.google.script.run.getSantriTindakan === 'function') {
        global.google.script.run
          .withSuccessHandler(serverList => {
            if (!Array.isArray(serverList)) return;
            const localOnly = readLocalTindakan().filter(x => x.localOnly);
            const sIds = new Set(serverList.map(x => String(x.id)));
            writeLocalTindakan(serverList.concat(localOnly.filter(x => !sIds.has(String(x.id)))));
            renderRoleBentoDashboard();
          })
          .withFailureHandler(() => {})
          .getSantriTindakan();
      }
    } catch (e) {}
  }

  function getApprovedIzinForStaff(namaStaff, dateStr) {
    const list = izinListCache.length ? izinListCache : readLocalIzin();
    const targetName = normText(namaStaff);
    const checkDate = String(dateStr || getTodayWib()).slice(0, 10);
    if (!targetName || !checkDate) return null;

    return list.find(item => {
      if (String(item.status || '') !== 'Disetujui') return false;
      const roleP = normText(item.peranPengaju);
      if (roleP && roleP !== 'musyrif' && roleP !== 'pengajar' && roleP !== 'admin') return false;
      const itemName = normText(item.namaSantri || item.namaPemohon);
      if (!itemName || itemName !== targetName) return false;
      const start = String(item.startDate || '').slice(0, 10);
      const end = String(item.endDate || start).slice(0, 10);
      if (!start) return false;
      return checkDate >= start && checkDate <= end;
    }) || null;
  }

  function getApprovedIzinForSantri() {
    // Izin Digital khusus diperuntukkan bagi Musyrif & Pengajar, bukan Santri
    return null;
  }

  // ===================== 3. IZIN DIGITAL UI & PERSETUJUAN =====================
  function setIzinFilter(filterKey) {
    activeIzinFilter = filterKey || 'all';
    document.querySelectorAll('.izin-filter-btn').forEach(btn => {
      const act = btn.id === 'izinFilterBtn_' + activeIzinFilter;
      btn.classList.toggle('bg-emerald-600', act);
      btn.classList.toggle('text-white', act);
      btn.classList.toggle('shadow-sm', act);
      btn.classList.toggle('bg-slate-100', !act);
      btn.classList.toggle('dark:bg-slate-800', !act);
      btn.classList.toggle('text-slate-600', !act);
      btn.classList.toggle('dark:text-slate-300', !act);
    });
    renderIzinDigitalUI();
  }

  function getAllSantriDirectory() {
    const cd = global.coreData || {};
    const map = new Map();
    (cd.santriWB || []).forEach(s => {
      const nama = typeof s === 'object' ? String(s.nama || '').trim() : String(s || '').trim();
      if (!nama) return;
      const key = normText(nama);
      const cur = map.get(key) || { nama, kamar: '', kelas: '' };
      cur.kamar = typeof s === 'object' ? String(s.kamar || '').trim() : cur.kamar;
      map.set(key, cur);
    });
    (cd.santriTakhassus || []).forEach(s => {
      const nama = typeof s === 'object' ? String(s.nama || '').trim() : String(s || '').trim();
      if (!nama) return;
      const key = normText(nama);
      const cur = map.get(key) || { nama, kamar: '', kelas: '' };
      if (typeof s === 'object') {
        cur.kelas = [s.kelas, s.qismu].filter(Boolean).join(' - ');
      }
      map.set(key, cur);
    });
    return Array.from(map.values()).sort((a, b) => a.nama.localeCompare(b.nama));
  }

  function getStaffDirectory() {
    const md = global.masterData || {};
    const cd = global.coreData || {};
    const map = new Map();
    const addStaff = (nama, roleLabel, unit) => {
      const cleanNama = String(nama || '').trim();
      if (!cleanNama) return;
      const key = roleLabel.toLowerCase() + ':' + normText(cleanNama);
      if (!map.has(key)) {
        map.set(key, {
          nama: cleanNama,
          roleLabel: roleLabel,
          unit: unit ? `${roleLabel} • ${unit}` : roleLabel
        });
      }
    };
    (md.musyrifs || []).concat(cd.musyrifs || []).forEach(m => {
      if (m && m.nama) addStaff(m.nama, 'Musyrif', String(m.kamar || '').trim());
    });
    (md.pengajars || []).concat(cd.pengajars || []).forEach(p => {
      if (p && p.nama) {
        const cls = [p.kelas, p.qismu].filter(Boolean).join(' - ').trim();
        addStaff(p.nama, 'Pengajar', cls);
      }
    });
    return Array.from(map.values()).sort((a, b) => a.nama.localeCompare(b.nama));
  }

  function getIzinDeadlineStatus(startDateStr) {
    if (global.AlRifaieAdminSettings && typeof global.AlRifaieAdminSettings.evaluateIzinDeadline === 'function') {
      return global.AlRifaieAdminSettings.evaluateIzinDeadline(startDateStr);
    }
    return { enabled: false, isExpired: false, diffMinutes: 0, deadlineTime: '' };
  }

  function renderIzinDeadlineBanner() {
    const el = document.getElementById('izinDeadlineBanner');
    if (!el) return;
    const ev = getIzinDeadlineStatus(getTodayWib());
    if (!ev || !ev.enabled) {
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    if (ev.isExpired) {
      el.className = 'p-3 rounded-2xl bg-red-50/90 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 flex items-start gap-2.5 text-xs';
      el.innerHTML = `<div class="w-8 h-8 rounded-xl bg-red-100 dark:bg-red-900/60 text-red-600 dark:text-red-300 flex items-center justify-center shrink-0"><i class="fa-solid fa-hourglass-end"></i></div>
        <div class="min-w-0 flex-1">
          <div class="font-extrabold text-red-700 dark:text-red-300">Batas Waktu Izin Hari Ini Telah Lewat (${escHtml(ev.deadlineTime)} WIB)</div>
          <p class="text-[11px] text-red-600/90 dark:text-red-300/85 mt-0.5 leading-snug">Pengajuan izin untuk hari ini yang melewati pukul <b>${escHtml(ev.deadlineTime)} WIB</b> akan <b>otomatis tertolak oleh sistem</b>. Pengajuan untuk tanggal besok atau setelahnya tetap dapat diproses.</p>
        </div>`;
    } else {
      el.className = 'p-3 rounded-2xl bg-emerald-50/90 dark:bg-emerald-950/35 border border-emerald-200 dark:border-emerald-900/60 flex items-start gap-2.5 text-xs';
      el.innerHTML = `<div class="w-8 h-8 rounded-xl bg-emerald-100 dark:bg-emerald-900/60 text-emerald-700 dark:text-emerald-300 flex items-center justify-center shrink-0"><i class="fa-regular fa-clock"></i></div>
        <div class="min-w-0 flex-1">
          <div class="font-extrabold text-emerald-800 dark:text-emerald-300">Batas Pengajuan Izin Hari Ini: ${escHtml(ev.deadlineTime)} WIB</div>
          <p class="text-[11px] text-emerald-700/90 dark:text-emerald-300/85 mt-0.5 leading-snug">Pengajuan sebelum batas waktu diteruskan ke Admin untuk persetujuan. Jika melewati <b>${escHtml(ev.deadlineTime)} WIB</b>, izin otomatis tertolak.</p>
        </div>`;
    }
  }

  function updateIzinFormDeadlineNotice() {
    const noticeEl = document.getElementById('izFormDeadlineNotice');
    if (!noticeEl) return;
    const sess = global.session || {};
    if (sess.role === 'admin') {
      noticeEl.classList.add('hidden');
      return;
    }
    const startVal = document.getElementById('izStartDate')?.value || getTodayWib();
    const ev = getIzinDeadlineStatus(startVal);
    if (!ev || !ev.enabled) {
      noticeEl.classList.add('hidden');
      return;
    }
    noticeEl.classList.remove('hidden');
    if (ev.isExpired) {
      noticeEl.className = 'p-2.5 rounded-xl bg-red-50 dark:bg-red-950/45 border border-red-200 dark:border-red-800/60 text-[11px] text-red-700 dark:text-red-300 font-semibold flex items-start gap-2';
      noticeEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation mt-0.5 shrink-0"></i><span><b>Perhatian:</b> Waktu pengajuan untuk tanggal ini telah melewati batas Admin (<b>${escHtml(ev.deadlineTime)} WIB</b>). Jika tetap dikirim, pengajuan akan <b>otomatis tertolak</b>.</span>`;
    } else {
      noticeEl.className = 'p-2.5 rounded-xl bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200/70 dark:border-indigo-800/50 text-[11px] text-indigo-700 dark:text-indigo-300 font-medium flex items-start gap-2';
      noticeEl.innerHTML = `<i class="fa-regular fa-clock mt-0.5 shrink-0"></i><span>Batas pengajuan izin hari ini pukul <b>${escHtml(ev.deadlineTime)} WIB</b>. Pengajuan Anda masih dalam batas waktu yang berlaku.</span>`;
    }
  }

  function renderIzinDigitalUI() {
    const container = document.getElementById('izinDigitalList');
    const pendingBadge = document.getElementById('izinPendingCountBadge');
    const openBtn = document.getElementById('btnOpenIzinForm');
    const subEl = document.getElementById('izinTabSubtitle');
    const list = izinListCache.length ? izinListCache : readLocalIzin();
    izinListCache = list;

    renderIzinDeadlineBanner();

    const sess = global.session || {};
    const isAdmin = sess.role === 'admin';
    const isStaff = sess.role === 'musyrif' || sess.role === 'pengajar';
    const myNameNorm = normText(sess.name || sess.username || '');

    if (openBtn) {
      openBtn.classList.toggle('hidden', !canSubmitIzin());
    }
    if (subEl) {
      subEl.innerText = isAdmin
        ? 'Tinjau, setujui, atau tolak pengajuan izin dari Musyrif & Pengajar'
        : 'Ajukan izin berhalangan hadir Anda untuk disetujui oleh Admin';
    }

    // Filter hanya pengajuan izin staf (Musyrif / Pengajar / Admin), dan jika login sebagai Musyrif/Pengajar hanya tampilkan miliknya sendiri
    const staffOnlyList = list.filter(it => {
      const rp = normText(it.peranPengaju);
      return !rp || rp === 'musyrif' || rp === 'pengajar' || rp === 'admin';
    });

    const visibleList = isAdmin
      ? staffOnlyList
      : (isStaff
        ? staffOnlyList.filter(it => {
            const nm = normText(it.namaSantri || it.namaPemohon);
            const pg = normText(it.pengaju);
            return myNameNorm && (nm === myNameNorm || pg === myNameNorm);
          })
        : []);

    const pendingCount = visibleList.filter(x => x.status === 'Menunggu').length;
    if (pendingBadge) pendingBadge.innerText = String(pendingCount);

    const setC = (id, v) => { const el = document.getElementById(id); if (el) el.innerText = String(v); };
    setC('izinCntAll', visibleList.length);
    setC('izinCntMenunggu', pendingCount);
    setC('izinCntDisetujui', visibleList.filter(x => x.status === 'Disetujui').length);
    setC('izinCntDitolak', visibleList.filter(x => x.status === 'Ditolak').length);

    if (!container) return;

    if (!isAdmin && !isStaff) {
      container.innerHTML = `<div class="clean-card p-8 text-center space-y-2 md:col-span-2">
        <div class="w-12 h-12 mx-auto rounded-2xl bg-slate-100 dark:bg-slate-800 text-slate-500 flex items-center justify-center text-lg"><i class="fa-solid fa-lock"></i></div>
        <div class="text-xs font-bold text-slate-700 dark:text-slate-200">Khusus Musyrif, Pengajar &amp; Admin</div>
        <p class="text-[11px] text-slate-500">Menu Izin Digital hanya digunakan untuk pengajuan izin Musyrif / Pengajar dan persetujuan oleh Admin.</p>
      </div>`;
      return;
    }

    const q = (document.getElementById('izinSearchInput')?.value || '').trim().toLowerCase();
    const filtered = visibleList.filter(it => {
      if (activeIzinFilter !== 'all' && it.status !== activeIzinFilter) return false;
      if (!q) return true;
      return normText(it.namaSantri || it.namaPemohon).includes(q) ||
        normText(it.kamarKelas).includes(q) ||
        normText(it.jenis).includes(q) ||
        normText(it.alasan).includes(q);
    });

    if (!filtered.length) {
      container.innerHTML = `<div class="clean-card p-8 text-center space-y-2 md:col-span-2">
        <div class="w-12 h-12 mx-auto rounded-2xl bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400 flex items-center justify-center text-lg"><i class="fa-solid fa-file-circle-check"></i></div>
        <div class="text-xs font-bold text-slate-700 dark:text-slate-200">Belum ada pengajuan izin pada filter ini</div>
        <p class="text-[11px] text-slate-500">${isAdmin ? 'Pengajuan izin dari Musyrif & Pengajar akan muncul di sini untuk Anda setujui.' : 'Ketuk tombol <b>+ Ajukan Izin</b> untuk mengirim permohonan izin ke Admin.'}</p>
      </div>`;
      return;
    }

    const canApprove = canApproveIzin();
    const todayStr = getTodayWib();

    container.innerHTML = filtered.map(it => {
      const isApproved = it.status === 'Disetujui';
      const isRejected = it.status === 'Ditolak';
      const isPending = !isApproved && !isRejected;
      const isActiveToday = isApproved && todayStr >= String(it.startDate || '').slice(0, 10) && todayStr <= String(it.endDate || it.startDate || '').slice(0, 10);

      const isAutoRejected = isRejected && /otomatis|sistem/i.test(String(it.diprosesOleh || '') + ' ' + String(it.catatanAdmin || ''));
      const statusPill = isApproved
        ? '<span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 dark:bg-emerald-950/80 text-emerald-700 dark:text-emerald-300"><i class="fa-solid fa-check-circle mr-1"></i>Disetujui Admin</span>'
        : (isRejected
          ? (isAutoRejected
            ? '<span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-red-100 dark:bg-red-950/80 text-red-700 dark:text-red-300"><i class="fa-solid fa-hourglass-end mr-1"></i>Otomatis Ditolak</span>'
            : '<span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-red-100 dark:bg-red-950/80 text-red-700 dark:text-red-300"><i class="fa-solid fa-circle-xmark mr-1"></i>Ditolak Admin</span>')
          : '<span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 dark:bg-amber-950/80 text-amber-800 dark:text-amber-300"><i class="fa-solid fa-clock mr-1"></i>Menunggu ACC Admin</span>');

      const jenisPill = it.jenis === 'Sakit'
        ? 'bg-rose-50 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300'
        : (it.jenis === 'Tugas Luar / Dinas'
          ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300'
          : 'bg-sky-50 dark:bg-sky-950/60 text-sky-700 dark:text-sky-300');

      const roleTag = normText(it.peranPengaju) === 'pengajar'
        ? '<span class="px-2 py-0.5 rounded-md text-[9.5px] font-bold bg-teal-50 dark:bg-teal-950/60 text-teal-700 dark:text-teal-300">Pengajar</span>'
        : (normText(it.peranPengaju) === 'musyrif'
          ? '<span class="px-2 py-0.5 rounded-md text-[9.5px] font-bold bg-sky-50 dark:bg-sky-950/60 text-sky-700 dark:text-sky-300">Musyrif</span>'
          : '');

      const safeId = escJsAttr(it.id);
      const isOwnPending = isStaff && isPending && (normText(it.namaSantri) === myNameNorm || normText(it.pengaju) === myNameNorm);

      const actionBar = (canApprove && isPending)
        ? `<div class="flex items-center gap-2 pt-2.5 mt-2.5 border-t border-slate-100 dark:border-slate-800">
            <button type="button" onclick="window.AlRifaieSmart.approveOrRejectIzin('${safeId}', 'Disetujui')" class="flex-1 py-2 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-bold inline-flex items-center justify-center gap-1.5 transition-all"><i class="fa-solid fa-check"></i><span>Setujui Izin</span></button>
            <button type="button" onclick="window.AlRifaieSmart.approveOrRejectIzin('${safeId}', 'Ditolak')" class="py-2 px-3 rounded-xl bg-red-50 dark:bg-red-950/60 text-red-600 dark:text-red-400 hover:bg-red-100 text-[11px] font-bold inline-flex items-center justify-center gap-1 transition-all"><i class="fa-solid fa-xmark"></i><span>Tolak</span></button>
          </div>`
        : (isAdmin
          ? `<div class="flex items-center justify-between pt-2 mt-2 border-t border-slate-100 dark:border-slate-800">
              <span class="text-[10px] text-slate-400">${it.diprosesOleh ? ('Diproses: ' + escHtml(it.diprosesOleh)) : ''}</span>
              <button type="button" onclick="window.AlRifaieSmart.deleteIzinItem('${safeId}')" class="px-2.5 py-1 rounded-lg bg-red-50 dark:bg-red-950/50 text-red-600 dark:text-red-400 text-[10px] font-bold"><i class="fa-solid fa-trash mr-1"></i>Hapus</button>
            </div>`
          : (isOwnPending
            ? `<div class="flex items-center justify-between pt-2 mt-2 border-t border-slate-100 dark:border-slate-800">
                <span class="text-[10px] text-amber-600 dark:text-amber-400 font-semibold">Menunggu konfirmasi Admin</span>
                <button type="button" onclick="window.AlRifaieSmart.deleteIzinItem('${safeId}')" class="px-2.5 py-1 rounded-lg bg-red-50 dark:bg-red-950/50 text-red-600 dark:text-red-400 text-[10px] font-bold"><i class="fa-solid fa-xmark mr-1"></i>Batalkan</button>
              </div>`
            : (it.diprosesOleh ? `<div class="text-[10px] text-slate-400 pt-2 mt-2 border-t border-slate-100 dark:border-slate-800">Diproses: <b>${escHtml(it.diprosesOleh)}</b></div>` : '')));

      const catatanHtml = it.catatanAdmin
        ? `<div class="mt-2 p-2 rounded-lg ${isRejected ? 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border border-red-200/70 dark:border-red-900/50' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'} text-[10.5px] font-semibold"><i class="fa-solid fa-circle-info mr-1"></i>${escHtml(it.catatanAdmin)}</div>`
        : '';

      return `<div class="bento-card p-4">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="font-bold text-sm text-slate-900 dark:text-white">${escHtml(it.namaSantri || it.namaPemohon)}</span>
              ${roleTag}
              <span class="px-2 py-0.5 rounded-md text-[10px] font-bold ${jenisPill}">${escHtml(it.jenis)}</span>
              ${isActiveToday ? '<span class="px-2 py-0.5 rounded-full text-[9px] font-extrabold bg-emerald-600 text-white">Aktif Hari Ini</span>' : ''}
            </div>
            <div class="text-[11px] text-slate-500 mt-0.5">${escHtml(it.kamarKelas || 'Musyrif / Pengajar')}</div>
          </div>
          <div class="shrink-0">${statusPill}</div>
        </div>
        <div class="mt-2.5 p-2.5 rounded-xl bg-slate-50/90 dark:bg-slate-800/60 border border-slate-200/70 dark:border-slate-700/60 text-xs space-y-1">
          <div class="flex items-center gap-2 text-[11px] font-bold text-indigo-700 dark:text-indigo-300">
            <i class="fa-regular fa-calendar-days"></i>
            <span>${escHtml(formatIndoDate(it.startDate))}${it.endDate && it.endDate !== it.startDate ? (' s/d ' + escHtml(formatIndoDate(it.endDate))) : ''}</span>
          </div>
          <p class="text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">${escHtml(it.alasan || 'Tanpa keterangan tambahan')}</p>
        </div>
        ${catatanHtml}
        ${actionBar}
      </div>`;
    }).join('');
  }

  function openIzinFormSheet() {
    if (!canSubmitIzin()) {
      if (typeof global.Swal !== 'undefined') {
        global.Swal.fire('Akses Dibatasi', 'Izin Digital hanya diperuntukkan bagi Musyrif dan Pengajar untuk disetujui oleh Admin.', 'warning');
      }
      return;
    }
    const sess = global.session || {};
    const today = getTodayWib();
    const isAdmin = sess.role === 'admin';
    const staffDir = getStaffDirectory();

    let defaultNama = '';
    let defaultUnit = '';
    if (!isAdmin) {
      const assign = resolveStaffAssignment(sess);
      const rolePrefix = sess.role === 'musyrif' ? 'Musyrif' : 'Pengajar';
      defaultNama = String(sess.name || '').trim();
      defaultUnit = assign.targets.length ? `${rolePrefix} • ${assign.label}` : rolePrefix;
    }

    const datalistOptions = staffDir.map(s => `<option value="${escHtml(s.nama)}">${escHtml(s.unit)}</option>`).join('');

    const bodyHtml = `<form id="smartIzinForm" onsubmit="window.AlRifaieSmart.submitIzinDigitalForm(event)" class="space-y-3">
      <div>
        <label class="block text-xs font-bold text-slate-700 dark:text-slate-200 mb-1">Nama Musyrif / Pengajar</label>
        <input type="text" id="izNamaSantri" list="izStaffDatalist" value="${escHtml(defaultNama)}" ${!isAdmin ? 'readonly' : ''} oninput="window.AlRifaieSmart.autoFillIzinKamar(this.value)" placeholder="Pilih atau ketik nama musyrif / pengajar..." class="clean-input w-full px-3.5 py-2.5 text-xs font-semibold ${!isAdmin ? 'opacity-80' : ''}" required>
        <datalist id="izStaffDatalist">${datalistOptions}</datalist>
      </div>
      <div class="grid grid-cols-2 gap-2.5">
        <div>
          <label class="block text-xs font-bold text-slate-700 dark:text-slate-200 mb-1">Peran &amp; Tugas</label>
          <input type="text" id="izKamarKelas" value="${escHtml(defaultUnit)}" ${!isAdmin ? 'readonly' : ''} placeholder="Otomatis / ketik..." class="clean-input w-full px-3 py-2.5 text-xs font-semibold ${!isAdmin ? 'opacity-80' : ''}">
        </div>
        <div>
          <label class="block text-xs font-bold text-slate-700 dark:text-slate-200 mb-1">Jenis Izin</label>
          <select id="izJenis" class="clean-input w-full px-3 py-2.5 text-xs font-semibold">
            <option value="Sakit">Sakit</option>
            <option value="Keperluan Keluarga">Keperluan Keluarga</option>
            <option value="Tugas Luar / Dinas">Tugas Luar / Dinas</option>
            <option value="Izin Pribadi">Izin Pribadi</option>
          </select>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-2.5">
        <div>
          <label class="block text-xs font-bold text-slate-700 dark:text-slate-200 mb-1">Mulai Tanggal</label>
          <input type="date" id="izStartDate" value="${today}" onchange="window.AlRifaieSmart && window.AlRifaieSmart.updateIzinFormDeadlineNotice()" class="clean-input w-full px-3 py-2.5 text-xs font-semibold" required>
        </div>
        <div>
          <label class="block text-xs font-bold text-slate-700 dark:text-slate-200 mb-1">Sampai Tanggal</label>
          <input type="date" id="izEndDate" value="${today}" class="clean-input w-full px-3 py-2.5 text-xs font-semibold" required>
        </div>
      </div>
      <div id="izFormDeadlineNotice" class="hidden"></div>
      <div>
        <label class="block text-xs font-bold text-slate-700 dark:text-slate-200 mb-1">Alasan / Keterangan (dan Badal jika ada)</label>
        <textarea id="izAlasan" rows="3" placeholder="Tuliskan alasan berhalangan hadir dan keterangan pengganti/badal bila ada..." class="clean-input w-full px-3.5 py-2.5 text-xs font-medium" required></textarea>
      </div>
      <p class="text-[10.5px] text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 p-2.5 rounded-xl">
        <i class="fa-solid fa-user-check mr-1"></i>${isAdmin ? 'Izin yang dicatat Admin langsung berstatus <b>Disetujui</b> &amp; otomatis tercatat di Absensi Musyrif/Pengajar.' : 'Pengajuan izin Anda akan dikirim ke <b>Admin</b> untuk disetujui. Jika melewati jam batas yang ditetapkan Admin, izin akan <b>otomatis tertolak</b>.'}
      </p>
      <div class="flex gap-2 pt-1">
        <button type="button" onclick="window.AlRifaieSmart.closeBottomSheet()" class="flex-1 py-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs font-bold">Batal</button>
        <button type="submit" class="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 text-white text-xs font-bold shadow-md">Kirim ke Admin</button>
      </div>
    </form>`;

    openBottomSheet('Ajukan Izin Musyrif / Pengajar', 'Persetujuan oleh Admin Departemen Pendidikan', bodyHtml, '');
    setTimeout(() => updateIzinFormDeadlineNotice(), 30);
  }

  function autoFillIzinKamar(namaVal) {
    const kEl = document.getElementById('izKamarKelas');
    if (!kEl) return;
    const match = getStaffDirectory().find(s => normText(s.nama) === normText(namaVal));
    if (match) {
      kEl.value = match.unit;
    }
  }

  function submitIzinDigitalForm(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    if (!canSubmitIzin()) return;
    const sess = global.session || {};
    const isAdmin = sess.role === 'admin';
    const namaPemohon = isAdmin
      ? (document.getElementById('izNamaSantri')?.value || '').trim()
      : String(sess.name || '').trim();
    const kamarKelas = (document.getElementById('izKamarKelas')?.value || '').trim();
    const jenis = (document.getElementById('izJenis')?.value || 'Izin Pribadi').trim();
    const startDate = (document.getElementById('izStartDate')?.value || '').trim();
    const endDate = (document.getElementById('izEndDate')?.value || startDate).trim();
    const alasan = (document.getElementById('izAlasan')?.value || '').trim();

    if (!namaPemohon || !startDate || !alasan) {
      if (typeof global.Swal !== 'undefined') global.Swal.fire('Lengkapi Data', 'Nama, tanggal, dan alasan izin wajib diisi.', 'warning');
      return;
    }
    if (endDate < startDate) {
      if (typeof global.Swal !== 'undefined') global.Swal.fire('Tanggal Tidak Valid', 'Tanggal selesai tidak boleh lebih awal dari tanggal mulai.', 'warning');
      return;
    }

    const id = 'iz_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    let initialStatus = isAdmin ? 'Disetujui' : 'Menunggu';
    let diprosesOleh = isAdmin ? (sess.name || 'Admin') : '';
    let catatanAdmin = '';
    let autoRejected = false;

    if (!isAdmin) {
      const dlEval = getIzinDeadlineStatus(startDate);
      if (dlEval && dlEval.enabled && dlEval.isExpired) {
        initialStatus = 'Ditolak';
        diprosesOleh = 'Sistem (Otomatis)';
        catatanAdmin = `Ditolak otomatis: melewati batas waktu pengajuan izin (${dlEval.deadlineTime} WIB).`;
        autoRejected = true;
      }
    }

    const record = {
      id: id,
      namaSantri: namaPemohon,
      kamarKelas: kamarKelas || (sess.role === 'musyrif' ? 'Musyrif' : (sess.role === 'pengajar' ? 'Pengajar' : 'Staf')),
      jenis: jenis,
      startDate: startDate,
      endDate: endDate,
      alasan: alasan,
      pengaju: sess.name || sess.username || namaPemohon,
      peranPengaju: sess.role || '',
      status: initialStatus,
      diprosesOleh: diprosesOleh,
      catatanAdmin: catatanAdmin,
      createdAt: new Date().toISOString(),
      localOnly: true
    };

    const next = [record].concat(readLocalIzin());
    writeLocalIzin(next);
    closeBottomSheet();
    renderIzinDigitalUI();
    renderRoleBentoDashboard();

    try {
      if (global.google && global.google.script && global.google.script.run && typeof global.google.script.run.saveIzinDigital === 'function') {
        global.google.script.run
          .withSuccessHandler(res => {
            if (res && res.success) {
              const synced = readLocalIzin().map(x => x.id === id
                ? Object.assign({}, x, {
                    id: res.id || id,
                    status: res.status || initialStatus,
                    diprosesOleh: res.diprosesOleh || diprosesOleh,
                    catatanAdmin: res.catatanAdmin || catatanAdmin,
                    localOnly: false
                  })
                : x);
              writeLocalIzin(synced);
              renderIzinDigitalUI();
            }
          })
          .withFailureHandler(() => {})
          .saveIzinDigital(record);
      }
    } catch (err) {}

    if (typeof global.Swal !== 'undefined') {
      if (autoRejected) {
        global.Swal.fire(
          'Izin Otomatis Tertolak',
          catatanAdmin + ' Silakan hubungi Admin jika ada keperluan mendesak.',
          'error'
        );
      } else {
        global.Swal.fire('Pengajuan Terkirim', initialStatus === 'Disetujui'
          ? 'Izin langsung disetujui & otomatis terhubung ke absensi Musyrif/Pengajar.'
          : 'Pengajuan izin Anda berhasil dikirim dan menunggu persetujuan Admin.', 'success');
      }
    }
  }

  function approveOrRejectIzin(id, nextStatus) {
    if (!canApproveIzin()) {
      if (typeof global.Swal !== 'undefined') global.Swal.fire('Akses Ditolak', 'Hanya Admin yang dapat menyetujui atau menolak pengajuan izin.', 'error');
      return;
    }
    const approver = (global.session && global.session.name) ? global.session.name : 'Admin';
    const updated = readLocalIzin().map(x => String(x.id) === String(id)
      ? Object.assign({}, x, { status: nextStatus, diprosesOleh: approver })
      : x);
    writeLocalIzin(updated);
    renderIzinDigitalUI();
    renderRoleBentoDashboard();

    try {
      if (global.google && global.google.script && global.google.script.run && typeof global.google.script.run.updateIzinDigitalStatus === 'function') {
        global.google.script.run
          .withSuccessHandler(() => {})
          .withFailureHandler(() => {})
          .updateIzinDigitalStatus(id, nextStatus, approver, '');
      }
    } catch (e) {}

    if (typeof global.Swal !== 'undefined') {
      global.Swal.fire({
        toast: true,
        position: 'top',
        icon: nextStatus === 'Disetujui' ? 'success' : 'info',
        title: nextStatus === 'Disetujui' ? 'Izin disetujui Admin & terhubung ke absensi' : 'Pengajuan izin ditolak Admin',
        showConfirmButton: false,
        timer: 2200
      });
    }
  }

  function deleteIzinItem(id) {
    const sess = global.session;
    if (!sess) return;
    const all = readLocalIzin();
    const target = all.find(x => String(x.id) === String(id));
    if (!target) return;
    const isAdmin = sess.role === 'admin';
    const isOwnerPending = (sess.role === 'musyrif' || sess.role === 'pengajar') &&
      target.status === 'Menunggu' &&
      (normText(target.namaSantri) === normText(sess.name) || normText(target.pengaju) === normText(sess.name));
    if (!isAdmin && !isOwnerPending) return;

    const next = all.filter(x => String(x.id) !== String(id));
    writeLocalIzin(next);
    renderIzinDigitalUI();
    renderRoleBentoDashboard();
    try {
      if (global.google && global.google.script && global.google.script.run && typeof global.google.script.run.deleteIzinDigital === 'function') {
        global.google.script.run.withSuccessHandler(() => {}).withFailureHandler(() => {}).deleteIzinDigital(id);
      }
    } catch (e) {}
  }

  // ===================== 4. CETAK SURAT PERNYATAAN & HUKUMAN (SANTRI & MUSYRIF) =====================
  function fetchRekapCached(actType) {
    return new Promise(resolve => {
      try {
        if (global.rekCache && Array.isArray(global.rekCache[actType]) && global.rekCache[actType].length > 0) {
          resolve(global.rekCache[actType]);
          return;
        }
        if (global.google && global.google.script && global.google.script.run && typeof global.google.script.run.getRekapData === 'function') {
          global.google.script.run
            .withSuccessHandler(res => {
              const arr = Array.isArray(res) ? res : [];
              if (!global.rekCache) global.rekCache = {};
              if (arr.length > 0 || !global.rekCache[actType]) {
                global.rekCache[actType] = arr;
              }
              if (typeof global.syncMissingFromRekapUpdate === 'function') {
                global.syncMissingFromRekapUpdate(actType);
              }
              resolve(global.rekCache[actType] || []);
            })
            .withFailureHandler(() => resolve((global.rekCache && global.rekCache[actType]) || []))
            .getRekapData(actType);
        } else {
          resolve([]);
        }
      } catch (e) {
        resolve([]);
      }
    });
  }

  function filterRowsByActiveRekapPeriod(rows) {
    const timeMode = document.getElementById('rekTime')?.value || 'month';
    const monthVal = document.getElementById('rekMonth')?.value || getTodayWib().slice(5, 7);
    const yearVal = document.getElementById('rekYear')?.value || getTodayWib().slice(0, 4);
    const mStart = document.getElementById('rekMonthStart')?.value || '01';
    const yStart = document.getElementById('rekYearStart')?.value || yearVal;
    const mEnd = document.getElementById('rekMonthEnd')?.value || monthVal;
    const yEnd = document.getElementById('rekYearEnd')?.value || yearVal;
    const singleDate = document.getElementById('rekDateSingle')?.value || '';
    const startDate = document.getElementById('rekDateStart')?.value || '';
    const endDate = document.getElementById('rekDateEnd')?.value || '';
    const todayStr = getTodayWib();

    let lowYM = `${yStart}-${mStart}`;
    let highYM = `${yEnd}-${mEnd}`;
    if (lowYM > highYM) { const tmp = lowYM; lowYM = highYM; highYM = tmp; }

    const weekCutoff = (() => {
      const d = new Date(todayStr + 'T00:00:00');
      d.setDate(d.getDate() - 6);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })();

    return (rows || []).filter(r => {
      const tgl = String(r.tanggal || '');
      if (timeMode === 'today') return tgl === todayStr;
      if (timeMode === 'week') return tgl >= weekCutoff && tgl <= todayStr;
      if (timeMode === 'month') return tgl.startsWith(`${yearVal}-${monthVal}`);
      if (timeMode === 'month_range') {
        const ym = tgl.slice(0, 7);
        return ym >= lowYM && ym <= highYM;
      }
      if (timeMode === 'date' && singleDate) return tgl === singleDate;
      if (timeMode === 'range' && startDate && endDate) return tgl >= startDate && tgl <= endDate;
      return true;
    });
  }

  function switchSuratTarget(mode) {
    suratTargetMode = mode === 'musyrif' ? 'musyrif' : 'santri';
    suratCheckedSet.clear();
    document.querySelectorAll('.surat-target-btn').forEach(btn => {
      const act = btn.id === 'suratTargetBtn_' + suratTargetMode;
      btn.classList.toggle('bg-indigo-600', act);
      btn.classList.toggle('text-white', act);
      btn.classList.toggle('shadow-sm', act);
      btn.classList.toggle('bg-slate-100', !act);
      btn.classList.toggle('dark:bg-slate-800', !act);
      btn.classList.toggle('text-slate-600', !act);
      btn.classList.toggle('dark:text-slate-300', !act);
    });
    renderSuratDisiplinPanel();
  }

  function switchSuratDocType(docType) {
    suratDocType = docType === 'hukuman' ? 'hukuman' : 'pernyataan';
    const wrap = document.getElementById('suratHukumanConfigWrap');
    if (wrap) wrap.classList.toggle('hidden', suratDocType !== 'hukuman');
    document.querySelectorAll('.surat-doc-btn').forEach(btn => {
      const act = btn.id === 'suratDocBtn_' + suratDocType;
      btn.classList.toggle('bg-emerald-600', act);
      btn.classList.toggle('text-white', act);
      btn.classList.toggle('shadow-sm', act);
      btn.classList.toggle('bg-slate-100', !act);
      btn.classList.toggle('dark:bg-slate-800', !act);
      btn.classList.toggle('text-slate-600', !act);
      btn.classList.toggle('dark:text-slate-300', !act);
    });
    updateSuratSelectedCountUI();
  }

  function applyHukumanPreset(text) {
    const el = document.getElementById('suratHukumanText');
    if (el) el.value = text;
  }

  async function renderSuratDisiplinPanel(preselectName) {
    if (!global.session || global.session.role !== 'admin') return;
    const tbody = document.getElementById('suratAlpaTableBody');
    const periodEl = document.getElementById('suratPeriodLabel');
    if (periodEl) {
      periodEl.innerText = document.getElementById('roomRecapPeriodBadge')?.innerText || 'Bulan Aktif';
    }
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="4" class="p-6 text-center text-slate-400 text-xs"><i class="fa-solid fa-spinner fa-spin mr-1.5"></i>Memuat daftar alpa ' + (suratTargetMode === 'musyrif' ? 'Musyrif' : 'Santri') + '...</td></tr>';

    let rawRecords = [];
    if (suratTargetMode === 'musyrif') {
      const musRows = await fetchRekapCached('musyrif');
      rawRecords = filterRowsByActiveRekapPeriod(musRows).map(r => Object.assign({}, r, { sumber: 'Musyrif' }));
    } else {
      const activeRekAct = document.getElementById('rekAct')?.value || 'wb';
      const [wbRows, tkRows] = await Promise.all([
        fetchRekapCached('wb'),
        fetchRekapCached('takhassus')
      ]);
      const fWb = filterRowsByActiveRekapPeriod(wbRows).map(r => Object.assign({}, r, { sumber: 'WB' }));
      const fTk = filterRowsByActiveRekapPeriod(tkRows).map(r => Object.assign({}, r, { sumber: 'Takhassus' }));
      rawRecords = (activeRekAct === 'takhassus' && fTk.length && !fWb.length) ? fTk : fWb.concat(fTk);
    }

    const grouped = {};
    rawRecords.forEach(r => {
      const nama = String(r.nama || '').trim();
      if (!nama) return;
      const keh = String(r.kehadiran || '').toLowerCase();
      const pel = String(r.pelanggaran || '').trim();
      const isAlpa = keh === 'alpa' || (keh !== 'hadir' && keh !== 'izin' && keh !== '');
      if (!isAlpa && !pel) return;

      const key = normText(nama);
      if (!grouped[key]) {
        grouped[key] = {
          key: key,
          nama: nama,
          kamar: String(r.target || (suratTargetMode === 'musyrif' ? 'Musyrif Kamar' : 'Umum')).trim(),
          alpaCount: 0,
          alpaDates: [],
          pelList: []
        };
      }
      if (isAlpa) {
        grouped[key].alpaCount++;
        grouped[key].alpaDates.push({ tanggal: String(r.tanggal || '-'), sumber: r.sumber || '' });
      }
      if (pel) {
        grouped[key].pelList.push({ tanggal: String(r.tanggal || '-'), ket: pel, sumber: r.sumber || '' });
      }
    });

    const baseAlpaList = Object.values(grouped)
      .filter(x => x.alpaCount > 0 || (preselectName && normText(x.nama) === normText(preselectName)));

    // Perbarui pilihan filter Kamar/Kelas secara dinamis untuk Admin
    const kamarSel = document.getElementById('suratKamarFilter');
    let selectedKamar = '';
    if (kamarSel) {
      selectedKamar = kamarSel.value || '';
      const distinctKamars = Array.from(new Set(baseAlpaList.map(x => x.kamar).filter(Boolean))).sort();
      const prevOpts = Array.from(kamarSel.options).map(o => o.value).join('|');
      const nextOpts = [''].concat(distinctKamars).join('|');
      if (prevOpts !== nextOpts) {
        kamarSel.innerHTML = '<option value="">Semua Kamar / Kelas</option>' +
          distinctKamars.map(k => `<option value="${escHtml(k)}">${escHtml(k)}</option>`).join('');
        if (distinctKamars.includes(selectedKamar)) kamarSel.value = selectedKamar;
        else selectedKamar = '';
      }
    }

    const searchQ = (document.getElementById('suratAlpaSearch')?.value || '').trim().toLowerCase();
    const list = baseAlpaList
      .filter(x => !selectedKamar || normText(x.kamar) === normText(selectedKamar))
      .filter(x => !searchQ || normText(x.nama).includes(searchQ) || normText(x.kamar).includes(searchQ))
      .sort((a, b) => b.alpaCount - a.alpaCount || a.nama.localeCompare(b.nama));

    suratLastRows = list;

    if (preselectName) {
      const targetKey = normText(preselectName);
      if (list.some(x => x.key === targetKey)) {
        suratCheckedSet.add(targetKey);
      }
    }

    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="p-6 text-center text-slate-400 text-xs">Tidak ditemukan ${suratTargetMode === 'musyrif' ? 'Musyrif' : 'Santri'} dengan catatan Alpa pada periode ini.</td></tr>`;
      updateSuratSelectedCountUI();
      return;
    }

    tbody.innerHTML = list.map(item => {
      const checked = suratCheckedSet.has(item.key);
      const safeKey = escJsAttr(item.key);
      const datePreview = item.alpaDates.slice(0, 3).map(d => d.tanggal).join(', ') + (item.alpaDates.length > 3 ? ` (+${item.alpaDates.length - 3})` : '');
      const pelNote = item.pelList.length
        ? `<div class="text-[10px] text-amber-600 dark:text-amber-400 mt-0.5 truncate"><i class="fa-solid fa-triangle-exclamation mr-1"></i>${escHtml(item.pelList[0].ket)}${item.pelList.length > 1 ? ` (+${item.pelList.length - 1})` : ''}</div>`
        : '';

      return `<tr class="hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors ${checked ? 'bg-indigo-50/50 dark:bg-indigo-950/25' : ''}">
        <td class="p-3 w-10 text-center">
          <input type="checkbox" ${checked ? 'checked' : ''} onchange="window.AlRifaieSmart.toggleSuratPerson('${safeKey}', this.checked)" class="w-4 h-4 rounded accent-indigo-600 cursor-pointer">
        </td>
        <td class="p-3 cursor-pointer" onclick="window.AlRifaieSmart.toggleSuratPerson('${safeKey}')">
          <div class="font-bold text-xs text-slate-900 dark:text-white">${escHtml(item.nama)}</div>
          <div class="text-[10px] text-slate-500">${escHtml(item.kamar)}</div>
          ${pelNote}
        </td>
        <td class="p-3 text-center whitespace-nowrap">
          <span class="px-2.5 py-0.5 rounded-full text-[11px] font-extrabold bg-red-100 dark:bg-red-950/70 text-red-700 dark:text-red-300">${item.alpaCount}x Alpa</span>
        </td>
        <td class="p-3 text-[10px] text-slate-500 hidden sm:table-cell">${escHtml(datePreview || '-')}</td>
      </tr>`;
    }).join('');

    updateSuratSelectedCountUI();
  }

  function toggleSuratPerson(key, explicitState) {
    const next = typeof explicitState === 'boolean' ? explicitState : !suratCheckedSet.has(key);
    if (next) suratCheckedSet.add(key);
    else suratCheckedSet.delete(key);
    renderSuratDisiplinPanel();
  }

  function toggleSelectAllSurat(selectAll) {
    if (selectAll) {
      suratLastRows.forEach(item => suratCheckedSet.add(item.key));
    } else {
      suratCheckedSet.clear();
    }
    renderSuratDisiplinPanel();
  }

  function updateSuratSelectedCountUI() {
    const cntEl = document.getElementById('suratSelectedCountText');
    const btn = document.getElementById('btnGenerateSuratDisiplinPdf');
    const count = suratLastRows.filter(x => suratCheckedSet.has(x.key)).length;
    if (cntEl) cntEl.innerText = count + ' dipilih';
    if (btn) {
      btn.disabled = count === 0;
      btn.classList.toggle('opacity-50', count === 0);
      const label = suratDocType === 'hukuman' ? 'Cetak Surat Hukuman' : 'Cetak Surat Pernyataan';
      btn.innerHTML = `<i class="fa-solid fa-file-pdf"></i><span>${label} (${count})</span>`;
    }
  }

  function openSuratDisiplinForPerson(targetMode, personName) {
    if (!global.session || global.session.role !== 'admin') {
      if (typeof global.Swal !== 'undefined') global.Swal.fire('Khusus Admin', 'Pembuatan Surat Pernyataan dan Surat Hukuman hanya dapat diakses oleh Admin.', 'info');
      return;
    }
    suratTargetMode = targetMode === 'musyrif' ? 'musyrif' : 'santri';
    suratCheckedSet.clear();
    if (typeof global.switchTab === 'function') global.switchTab('rekap');
    setTimeout(() => {
      if (global.AlRifaieAdminSettings && typeof global.AlRifaieAdminSettings.switchRekapCategory === 'function') {
        global.AlRifaieAdminSettings.switchRekapCategory('suratdisiplin');
      }
      switchSuratTarget(suratTargetMode);
      renderSuratDisiplinPanel(personName);
    }, 180);
  }

  function getOfficialSuratAssetsSafe() {
    if (typeof global.getOfficialSuratAssets === 'function') {
      return global.getOfficialSuratAssets();
    }
    const fallbackLogo = 'https://lh3.googleusercontent.com/d/1cVVxzS5pcO35NXDLh_W2YXUiSYuS3zg5';
    const rawLogo = String(document.getElementById('kopLogoKiri')?.src || document.querySelector('.logo-img')?.src || '').trim();
    let logoKiri = fallbackLogo;
    let logoKanan = '';
    let ttdKetua = '';
    let ttdSekretaris = '';
    let namaKetua = 'Ust. Feriyanto';
    let jabatanKetua = 'Ketua Dept. Pendidikan';
    let namaSekretaris = 'Ust. M. Amir Abdillah';
    let jabatanSekretaris = 'Sekretaris Dept. Pendidikan';
    try {
      logoKiri = localStorage.getItem('alrifaie_logo_kiri') || localStorage.getItem('alrifaie_logo') || (/^(https?:\/\/|data:image\/)/i.test(rawLogo) ? rawLogo : fallbackLogo);
      logoKanan = localStorage.getItem('alrifaie_logo_kanan') || '';
      ttdKetua = localStorage.getItem('alrifaie_ttd_ketua') || '';
      ttdSekretaris = localStorage.getItem('alrifaie_ttd_sekretaris') || '';
      namaKetua = localStorage.getItem('alrifaie_nama_ketua') || namaKetua;
      jabatanKetua = localStorage.getItem('alrifaie_jabatan_ketua') || jabatanKetua;
      namaSekretaris = localStorage.getItem('alrifaie_nama_sekretaris') || namaSekretaris;
      jabatanSekretaris = localStorage.getItem('alrifaie_jabatan_sekretaris') || jabatanSekretaris;
    } catch (e) {}
    return { logoKiri, logoKanan, ttdKetua, ttdSekretaris, namaKetua, jabatanKetua, namaSekretaris, jabatanSekretaris };
  }

  function buildOfficialKopHtml() {
    const a = getOfficialSuratAssetsSafe();
    const rightLogoHtml = a.logoKanan
      ? `<img src="${escHtml(a.logoKanan)}" crossorigin="anonymous" style="max-width:80px;max-height:80px;object-fit:contain;margin:0 auto;display:block;">`
      : `<div style="font-size:7pt;font-weight:700;color:#000000;text-align:center;">DEPT. PENDIDIKAN</div>`;
    return `<div style="display:flex;align-items:center;justify-content:space-between;border-bottom:3px double #000000;padding-bottom:8px;margin-bottom:14px;">
      <div style="width:18%;text-align:center;">
        <img src="${escHtml(a.logoKiri)}" crossorigin="anonymous" style="max-width:90px;max-height:90px;object-fit:contain;margin:0 auto;display:block;">
      </div>
      <div style="width:64%;text-align:center;font-family:'Times New Roman',Georgia,serif;color:#000000;line-height:1.28;">
        <p style="margin:0;font-size:11pt;font-weight:700;">Departemen Pendidikan</p>
        <p style="margin:0;font-size:12pt;font-weight:900;">YAYASAN PONDOK MODERN AL-RIFA'IE 2</p>
        <h1 style="margin:0;font-size:14pt;font-weight:900;text-transform:uppercase;">MAJELIS PONDOK PESANTREN PUTRA</h1>
        <p style="margin:2px 0 0 0;font-size:8.5pt;">Jl. Raya Ketawang No. 02 (0341) 876388 Gondanglegi - Malang 65174</p>
      </div>
      <div style="width:18%;text-align:center;">${rightLogoHtml}</div>
    </div>`;
  }

  function findMusyrifForTarget(targetName) {
    if (!targetName) return '-';
    const cd = global.coreData || {};
    const md = global.masterData || {};
    const musList = (cd.musyrifs || []).concat(md.musyrifs || []);
    const matched = [];
    const seen = new Set();
    musList.forEach(m => {
      if (!m || !m.nama) return;
      const rooms = String(m.kamar || m.f2 || '').split(',').map(x => x.trim()).filter(Boolean);
      if (rooms.length && targetMatchesAny(targetName, rooms)) {
        const key = normText(m.nama);
        if (!seen.has(key)) {
          seen.add(key);
          matched.push(String(m.nama).trim());
        }
      }
    });
    return matched.length ? matched.join(', ') : '-';
  }

  function buildOfficialTtdBlockHtml(todayIndo, opts) {
    const a = getOfficialSuratAssetsSafe();
    const hideDate = Boolean(opts && opts.hideDate);
    const ttdKetuaImg = a.ttdKetua
      ? `<img src="${escHtml(a.ttdKetua)}" crossorigin="anonymous" style="max-width:160px;max-height:80px;object-fit:contain;display:block;margin:0 auto;">`
      : '';
    const ttdSekImg = a.ttdSekretaris
      ? `<img src="${escHtml(a.ttdSekretaris)}" crossorigin="anonymous" style="max-width:160px;max-height:80px;object-fit:contain;display:block;margin:0 auto;">`
      : '';
    return `<div style="display:flex;justify-content:space-between;font-size:12pt;font-family:'Times New Roman',Georgia,serif;color:#000000;text-align:center;margin-top:14px;">
      <div style="width:50%;display:flex;flex-direction:column;align-items:center;padding-top:10px;">
        ${hideDate ? '' : '<div style="margin-bottom:4px;visibility:hidden;">Gondanglegi</div>'}
        <div style="height:80px;width:160px;display:flex;align-items:center;justify-content:center;margin-bottom:-6px;">${ttdKetuaImg}</div>
        <p style="margin:0;font-weight:700;text-decoration:underline;">${escHtml(a.namaKetua)}</p>
        <p style="margin:0;">${escHtml(a.jabatanKetua)}</p>
      </div>
      <div style="width:50%;display:flex;flex-direction:column;align-items:center;padding-top:10px;">
        ${hideDate ? '' : `<div style="margin-bottom:4px;">Gondanglegi, ${escHtml(todayIndo)}</div>`}
        <div style="height:80px;width:160px;display:flex;align-items:center;justify-content:center;margin-bottom:-6px;">${ttdSekImg}</div>
        <p style="margin:0;font-weight:700;text-decoration:underline;">${escHtml(a.namaSekretaris)}</p>
        <p style="margin:0;">${escHtml(a.jabatanSekretaris)}</p>
      </div>
    </div>`;
  }

  async function generateSuratDisiplinPdf() {
    if (!global.session || global.session.role !== 'admin') {
      if (typeof global.Swal !== 'undefined') global.Swal.fire('Khusus Admin', 'Pencetakan surat hanya diperbolehkan untuk Admin.', 'warning');
      return;
    }
    const selected = suratLastRows.filter(x => suratCheckedSet.has(x.key));
    if (!selected.length) {
      if (typeof global.Swal !== 'undefined') global.Swal.fire('Belum Ada Pilihan', 'Centang minimal 1 nama yang akan dibuatkan surat.', 'warning');
      return;
    }

    const isHukuman = suratDocType === 'hukuman';
    const isMusyrif = suratTargetMode === 'musyrif';
    const hukumanText = (document.getElementById('suratHukumanText')?.value || '').trim() ||
      (isMusyrif
        ? 'Pembinaan khusus bersama Ketua Departemen Pendidikan dan evaluasi tanggung jawab kepengurusan kamar.'
        : 'Melaksanakan tugas ta\'zir kebersihan lingkungan pesantren serta menyetorkan hafalan tambahan kepada Musyrif.');
    const periodText = document.getElementById('roomRecapPeriodBadge')?.innerText || 'Periode Berjalan';
    const todayStr = getTodayWib();
    const todayIndo = formatIndoDate(todayStr);
    const kopHtml = buildOfficialKopHtml();
    const ttdOfficialHtml = buildOfficialTtdBlockHtml(todayIndo);
    const ttdOfficialNoDateHtml = buildOfficialTtdBlockHtml(todayIndo, { hideDate: true });

    if (typeof global.Swal !== 'undefined') {
      global.Swal.fire({
        title: `Menyusun ${selected.length} Halaman Surat...`,
        text: 'Mohon tunggu sebentar...',
        allowOutsideClick: false,
        didOpen: () => global.Swal.showLoading()
      });
    }

    try {
      if (typeof global.ensureHtml2Pdf === 'function') await global.ensureHtml2Pdf();

      const romanMonths = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
      const monthIdx = Math.max(0, Math.min(11, parseInt(todayStr.slice(5, 7), 10) - 1));
      const romanMonth = romanMonths[monthIdx] || 'I';
      const yearNow = todayStr.slice(0, 4);
      const spArchivePayloads = [];

      const pagesHtml = selected.map((person, idx) => {
        const pageBreak = idx < selected.length - 1 ? 'page-break-after:always;break-after:page;' : '';
        const noSurat = `${String(idx + 1).padStart(2, '0')}/${isHukuman ? 'SH' : 'SP'}/MAA/DEPTPENDIK/${romanMonth}/${yearNow}`;
        const perihalText = isHukuman ? 'Surat Keputusan Hukuman (Ta\'zir)' : 'Surat Pernyataan Kedisiplinan';

        const sumberLabelMap = { WB: 'Wajib Belajar', Takhassus: 'Takhassus', Musyrif: 'Pendampingan Musyrif' };
        const uniqueSumber = Array.from(new Set(
          (person.alpaDates || []).map(d => sumberLabelMap[d.sumber] || d.sumber).filter(Boolean)
        ));
        const kegiatanText = uniqueSumber.length
          ? uniqueSumber.join(' & ')
          : (isMusyrif ? 'Pendampingan Musyrif' : 'Wajib Belajar');

        const tanggalListIndo = (person.alpaDates || []).map(d => formatIndoDate(d.tanggal));
        const rincianTanggalText = tanggalListIndo.length
          ? `${person.alpaCount} kali Alpa pada tanggal ${tanggalListIndo.slice(0, 8).join(', ')}${tanggalListIndo.length > 8 ? ` (+${tanggalListIndo.length - 8} hari lainnya)` : ''}`
          : `${person.alpaCount} kali Alpa pada periode ${periodText}`;

        const rincianRows = person.alpaDates.slice(0, 8).map((d, i) => `<tr>
          <td style="border:1px solid #000000;padding:3px 6px;text-align:center;">${i + 1}</td>
          <td style="border:1px solid #000000;padding:3px 6px;">${escHtml(formatIndoDate(d.tanggal))}</td>
          <td style="border:1px solid #000000;padding:3px 6px;">${escHtml(sumberLabelMap[d.sumber] || d.sumber || kegiatanText)}</td>
          <td style="border:1px solid #000000;padding:3px 6px;font-weight:700;">Alpa (Tanpa Keterangan)</td>
        </tr>`).join('');

        const pelExtraHtml = person.pelList.length
          ? `<div style="margin-top:6px;font-size:10.5pt;"><b>Catatan Pelanggaran Lain:</b> ${escHtml(person.pelList.slice(0, 4).map(p => `${formatIndoDate(p.tanggal)}: ${p.ket}`).join('; '))}</div>`
          : '';

        if (!isHukuman) {
          // FORMAT KHUSUS SURAT PERNYATAAN (SP):
          // Kop & Tanda Tangan sama dengan Surat Undangan; isi tanpa Nomor/Lampiran/Perihal, judul di tengah SURAT PERNYATAAN
          const musyrifName = isMusyrif ? person.nama : findMusyrifForTarget(person.kamar);
          const singleSpHtml = `<div style="width:210mm;min-height:296mm;box-sizing:border-box;background:#ffffff;color:#000000;padding:1.8cm 2.54cm 2.2cm 3cm;font-family:'Times New Roman',Georgia,serif;font-size:12pt;line-height:1.5;position:relative;${pageBreak}">
            ${kopHtml}
            <div style="text-align:center;margin:16px 0 20px 0;">
              <h2 style="margin:0;font-size:14pt;font-weight:900;text-transform:uppercase;letter-spacing:0.06em;text-decoration:underline;color:#000000;">SURAT PERNYATAAN</h2>
            </div>

            <p style="margin:0 0 10px 0;text-align:justify;">Saya yang bertanda tangan di bawah ini:</p>
            <table style="font-size:12pt;font-family:'Times New Roman',Georgia,serif;margin:0 0 14px 1cm;width:calc(100% - 1cm);color:#000000;border-collapse:collapse;">
              <tr><td style="width:22%;padding:3px 0;">Nama</td><td style="width:4%;">:</td><td style="font-weight:700;">${escHtml(person.nama)}</td></tr>
              <tr><td style="padding:3px 0;">Musyrif</td><td>:</td><td>${escHtml(musyrifName)}</td></tr>
              <tr><td style="padding:3px 0;">Kamar</td><td>:</td><td>${escHtml(person.kamar)}</td></tr>
            </table>

            <p style="margin:0 0 12px 0;text-indent:1cm;text-align:justify;">Telah melakukan pelanggaran pada kegiatan <b>${escHtml(kegiatanText)}</b> yaitu <b>Alpa</b> dengan rincian <b>${escHtml(rincianTanggalText)}</b>.</p>

            ${rincianRows ? `<div style="margin:8px 0 14px 0;">
              <table style="width:100%;border-collapse:collapse;font-size:10.5pt;">
                <thead><tr style="background:#f1f5f9;">
                  <th style="border:1px solid #000000;padding:3px 6px;width:30px;">No</th>
                  <th style="border:1px solid #000000;padding:3px 6px;text-align:left;">Tanggal</th>
                  <th style="border:1px solid #000000;padding:3px 6px;text-align:left;">Kegiatan</th>
                  <th style="border:1px solid #000000;padding:3px 6px;text-align:left;">Keterangan</th>
                </tr></thead>
                <tbody>${rincianRows}</tbody>
              </table>
              ${pelExtraHtml}
            </div>` : ''}

            <p style="margin:0 0 18px 0;text-indent:1cm;text-align:justify;">Saya bersedia bertanggung jawab atas sikap saya sesuai dengan hukuman yang telah ditentukan.</p>

            <div style="display:flex;justify-content:flex-end;margin-top:10px;margin-bottom:8px;font-size:12pt;font-family:'Times New Roman',Georgia,serif;color:#000000;">
              <div style="width:50%;text-align:center;">
                <div style="margin-bottom:2px;">Gondanglegi, ${escHtml(todayIndo)}</div>
                <div>Yang Membuat Pernyataan,</div>
                <div style="height:56px;"></div>
                <div style="font-weight:700;text-decoration:underline;">${escHtml(person.nama)}</div>
                <div style="font-size:10.5pt;">${isMusyrif ? 'Musyrif Kamar' : 'Santri'} (${escHtml(person.kamar)})</div>
              </div>
            </div>

            <div style="font-size:11.5pt;text-align:center;margin-top:10px;margin-bottom:-8px;color:#000000;">Mengetahui,</div>
            ${ttdOfficialNoDateHtml}
          </div>`;

          spArchivePayloads.push({
            id: 'local_sp_' + Date.now() + '_' + idx,
            nomor: `SP-${todayStr.replace(/-/g, '')}-${String(idx + 1).padStart(2, '0')}`,
            kategori: 'Surat SP',
            sub: isMusyrif ? 'Musyrif' : (person.kamar || 'Santri'),
            perihal: `Surat Pernyataan • ${kegiatanText} (${person.alpaCount}x Alpa)`,
            tujuan: `${person.nama} (${person.kamar})`,
            tanggal: todayStr,
            driveHtmlSnapshot: singleSpHtml,
            htmlSnapshot: singleSpHtml
          });

          return singleSpHtml;
        }

        // FORMAT SURAT HUKUMAN (TA'ZIR)
        const bodyParagraphs = `<p style="margin:0 0 6px 0;text-indent:1.27cm;text-align:justify;">Alhamdulillahi rabbil 'alamin, segala puji bagi Allah SWT atas segala limpahan rahmat, taufiq, dan hidayah-Nya kepada kita semua.</p>
             <p style="margin:0 0 8px 0;text-indent:1.27cm;text-align:justify;">Berdasarkan data rekapitulasi kehadiran Departemen Pendidikan pada periode <b>${escHtml(periodText)}</b>, yang bersangkutan di bawah ini tercatat melakukan ketidakhadiran tanpa keterangan (<b>Alpa</b>) sebanyak <b>${person.alpaCount} kali</b>:</p>`;

        const closingParagraphs = `<div style="border:1.5px solid #000000;padding:8px 12px;margin:8px 0;font-size:11pt;"><b>Keputusan Sanksi / Ta'zir:</b><br>${escHtml(hukumanText)}</div>
             <p style="margin:6px 0;text-indent:1.27cm;text-align:justify;">Demikian surat keputusan hukuman (ta'zir) ini kami sampaikan untuk dilaksanakan dengan penuh tanggung jawab serta menjadi bahan evaluasi agar tidak mengulangi pelanggaran serupa di kemudian hari.</p>`;

        return `<div style="width:210mm;min-height:296mm;box-sizing:border-box;background:#ffffff;color:#000000;padding:1.8cm 2.54cm 2.2cm 3cm;font-family:'Times New Roman',Georgia,serif;font-size:12pt;line-height:1.42;position:relative;${pageBreak}">
          ${kopHtml}
          <table style="width:100%;font-size:12pt;font-family:'Times New Roman',Georgia,serif;margin-bottom:10px;color:#000000;border-collapse:collapse;">
            <tr><td style="width:15%;padding:1px 0;">Nomor</td><td style="width:3%;">:</td><td>${escHtml(noSurat)}</td></tr>
            <tr><td style="padding:1px 0;">Lampiran</td><td>:</td><td>-</td></tr>
            <tr><td style="padding:1px 0;">Hal</td><td>:</td><td style="font-weight:700;">${escHtml(perihalText)}</td></tr>
          </table>
          <div style="font-size:12pt;margin-bottom:10px;color:#000000;">
            <p style="margin:0;">Yth. <b>${escHtml(person.nama)}</b> (${isMusyrif ? 'Musyrif' : 'Santri'} &bull; ${escHtml(person.kamar)})</p>
            <p style="margin:0;">-Di Tempat</p>
          </div>
          <div style="font-size:12pt;margin-bottom:6px;color:#000000;">Assalamu'alaikum Warahmatullahi Wabarakatuh</div>
          <div style="font-size:11.5pt;color:#000000;">
            ${bodyParagraphs}
          </div>
          <table style="font-size:11.5pt;font-family:'Times New Roman',Georgia,serif;margin:0 0 8px 1.27cm;width:calc(100% - 1.27cm);color:#000000;border-collapse:collapse;">
            <tr><td style="width:28%;padding:1.5px 0;">Nama Lengkap</td><td style="width:3%;">:</td><td style="font-weight:700;">${escHtml(person.nama)}</td></tr>
            <tr><td style="padding:1.5px 0;">Status / Peran</td><td>:</td><td>${isMusyrif ? 'Musyrif Kamar' : 'Santri'}</td></tr>
            <tr><td style="padding:1.5px 0;">Kamar / Kelas</td><td>:</td><td>${escHtml(person.kamar)}</td></tr>
            <tr><td style="padding:1.5px 0;">Jumlah Alpa</td><td>:</td><td><b>${person.alpaCount} kali</b> (${escHtml(periodText)})</td></tr>
          </table>
          ${rincianRows ? `<div style="margin:6px 0 8px 0;">
            <div style="font-size:10.5pt;font-weight:700;margin-bottom:3px;">Rincian Catatan Ketidakhadiran (Alpa):</div>
            <table style="width:100%;border-collapse:collapse;font-size:10pt;">
              <thead><tr style="background:#f1f5f9;">
                <th style="border:1px solid #000000;padding:3px 6px;width:28px;">No</th>
                <th style="border:1px solid #000000;padding:3px 6px;text-align:left;">Tanggal</th>
                <th style="border:1px solid #000000;padding:3px 6px;text-align:left;">Kegiatan</th>
                <th style="border:1px solid #000000;padding:3px 6px;text-align:left;">Status</th>
              </tr></thead>
              <tbody>${rincianRows}</tbody>
            </table>
            ${pelExtraHtml}
          </div>` : ''}
          <div style="font-size:11.5pt;color:#000000;">
            ${closingParagraphs}
          </div>
          <div style="font-size:12pt;margin-top:6px;margin-bottom:4px;color:#000000;">Wassalamu'alaikum Warahmatullahi Wabarakatuh</div>
          <div style="font-size:11pt;text-align:center;margin-top:6px;margin-bottom:-6px;color:#000000;">Mengetahui,</div>
          ${ttdOfficialHtml}
        </div>`;
      }).join('');

      const filename = `${isHukuman ? 'Surat_Hukuman' : 'Surat_Pernyataan_SP'}_${isMusyrif ? 'Musyrif' : 'Santri'}_${todayStr}.pdf`;
      await global.html2pdf().set({
        margin: 0,
        filename: filename,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, backgroundColor: '#ffffff', useCORS: true, scrollY: 0 },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: { mode: ['css', 'legacy'] }
      }).from(`<div>${pagesHtml}</div>`).save();

      // Simpan otomatis riwayat Surat Pernyataan ke Arsip Surat kategori "Surat SP" (+ cadangan Google Drive)
      if (!isHukuman && spArchivePayloads.length) {
        spArchivePayloads.forEach(item => {
          if (typeof global.saveLocalSpArchiveEntry === 'function') {
            global.saveLocalSpArchiveEntry(item);
          }
          try {
            if (global.google && global.google.script && global.google.script.run && typeof global.google.script.run.saveSuratData === 'function') {
              global.google.script.run
                .withSuccessHandler(() => {
                  if (typeof global.loadSurat === 'function') global.loadSurat();
                })
                .withFailureHandler(() => {})
                .saveSuratData({
                  nomor: item.nomor,
                  kategori: 'Surat SP',
                  sub: item.sub,
                  perihal: item.perihal,
                  tujuan: item.tujuan,
                  driveHtmlSnapshot: item.driveHtmlSnapshot
                });
            }
          } catch (saveErr) {}
        });
        if (typeof global.loadSurat === 'function') global.loadSurat();
      } else {
        // Cadangkan salinan PDF Surat Hukuman ke Google Drive di latar belakang
        try {
          if (global.google && global.google.script && global.google.script.run && typeof global.google.script.run.backupSuratPdfToDrive === 'function') {
            global.google.script.run
              .withSuccessHandler(() => {})
              .withFailureHandler(() => {})
              .backupSuratPdfToDrive({
                nomor: 'SH-' + todayStr.replace(/-/g, ''),
                perihal: `Surat Hukuman ${isMusyrif ? 'Musyrif' : 'Santri'} (${selected.length} orang)`,
                kategori: 'Surat Hukuman',
                tujuan: selected.map(s => s.nama).slice(0, 5).join(', '),
                html: `<div>${pagesHtml}</div>`
              });
          }
        } catch (drvErr) {}
      }

      if (typeof global.Swal !== 'undefined') {
        if (!isHukuman) {
          global.Swal.fire({
            icon: 'success',
            title: 'Surat Pernyataan Dicetak & Diarsipkan',
            text: `${spArchivePayloads.length} Surat Pernyataan berhasil dibuat dan otomatis tersimpan ke Arsip Surat kategori Surat SP.`,
            timer: 2600,
            showConfirmButton: false
          });
        } else {
          global.Swal.close();
        }
      }
    } catch (err) {
      if (typeof global.Swal !== 'undefined') {
        global.Swal.fire('Gagal Membuat PDF', 'Pastikan koneksi internet aktif saat pertama kali memuat generator PDF.', 'error');
      }
    }
  }

  // ===================== 4B. EKSPOR LAPORAN REKAP RESMI BERKOP PDF =====================
  async function downloadOfficialRekapPdf() {
    const stats = global.currentSStats || {};
    const names = Object.keys(stats).sort();
    if (!names.length) {
      if (typeof global.Swal !== 'undefined') global.Swal.fire('Data Kosong', 'Belum ada data rekap pada periode yang dipilih.', 'warning');
      return;
    }

    const actSel = document.getElementById('rekAct');
    const actText = actSel ? actSel.options[actSel.selectedIndex].text : 'Kehadiran';
    const periodText = document.getElementById('roomRecapPeriodBadge')?.innerText || 'Periode Aktif';
    const totH = document.getElementById('ctHadir')?.innerText || '0';
    const totI = document.getElementById('ctIzin')?.innerText || '0';
    const totA = document.getElementById('ctAlpa')?.innerText || '0';
    const pctH = document.getElementById('stHadir')?.innerText || '0%';

    if (typeof global.Swal !== 'undefined') {
      global.Swal.fire({ title: 'Menyusun Laporan Resmi PDF...', allowOutsideClick: false, didOpen: () => global.Swal.showLoading() });
    }

    try {
      if (typeof global.ensureHtml2Pdf === 'function') await global.ensureHtml2Pdf();
      const rowsHtml = names.map((n, idx) => {
        const s = stats[n];
        const totAlpa = (s.alpaLangsung || 0) + (s.alpaKonversi || 0);
        const pct = s.total ? Math.round((s.hadir / s.total) * 100) : 0;
        return `<tr>
          <td style="border:1px solid #cbd5e1;padding:4px 6px;text-align:center;">${idx + 1}</td>
          <td style="border:1px solid #cbd5e1;padding:4px 6px;font-weight:600;">${escHtml(n)}</td>
          <td style="border:1px solid #cbd5e1;padding:4px 6px;">${escHtml(s.kamar || '-')}</td>
          <td style="border:1px solid #cbd5e1;padding:4px 6px;text-align:center;color:#047857;font-weight:700;">${s.hadir}</td>
          <td style="border:1px solid #cbd5e1;padding:4px 6px;text-align:center;color:#b45309;font-weight:700;">${s.izin}</td>
          <td style="border:1px solid #cbd5e1;padding:4px 6px;text-align:center;color:#b91c1c;font-weight:700;">${totAlpa}</td>
          <td style="border:1px solid #cbd5e1;padding:4px 6px;text-align:center;font-weight:700;">${pct}%</td>
        </tr>`;
      }).join('');

      const htmlStr = `<div style="font-family:Arial,sans-serif;color:#0f172a;background:#fff;padding:16px;font-size:11px;line-height:1.45;">
        ${buildOfficialKopHtml()}
        <div style="text-align:center;margin-bottom:12px;">
          <div style="font-size:14px;font-weight:800;text-transform:uppercase;">LAPORAN REKAPITULASI KEHADIRAN ${escHtml(actText.toUpperCase())}</div>
          <div style="font-size:11px;color:#475569;">Periode: ${escHtml(periodText)} &bull; Dicetak: ${escHtml(formatIndoDate(getTodayWib()))}</div>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:12px;text-align:center;">
          <div style="flex:1;border:1px solid #d1fae5;background:#ecfdf5;padding:6px;border-radius:6px;"><div style="font-size:9px;color:#047857;font-weight:700;">HADIR (${escHtml(pctH)})</div><div style="font-size:13px;font-weight:800;">${escHtml(totH)}</div></div>
          <div style="flex:1;border:1px solid #fef3c7;background:#fffbeb;padding:6px;border-radius:6px;"><div style="font-size:9px;color:#b45309;font-weight:700;">IZIN</div><div style="font-size:13px;font-weight:800;">${escHtml(totI)}</div></div>
          <div style="flex:1;border:1px solid #fee2e2;background:#fef2f2;padding:6px;border-radius:6px;"><div style="font-size:9px;color:#b91c1c;font-weight:700;">ALPA</div><div style="font-size:13px;font-weight:800;">${escHtml(totA)}</div></div>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:10px;">
          <thead><tr style="background:#f1f5f9;">
            <th style="border:1px solid #cbd5e1;padding:5px;width:28px;">No</th>
            <th style="border:1px solid #cbd5e1;padding:5px;text-align:left;">Nama</th>
            <th style="border:1px solid #cbd5e1;padding:5px;text-align:left;">Kamar / Kelas</th>
            <th style="border:1px solid #cbd5e1;padding:5px;">Hadir</th>
            <th style="border:1px solid #cbd5e1;padding:5px;">Izin</th>
            <th style="border:1px solid #cbd5e1;padding:5px;">Alpa</th>
            <th style="border:1px solid #cbd5e1;padding:5px;">%</th>
          </tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        <div style="margin-top:22px;display:flex;justify-content:flex-end;">
          <div style="text-align:center;width:220px;">
            <div>Malang, ${escHtml(formatIndoDate(getTodayWib()))}</div>
            <div style="font-weight:700;margin-top:2px;">Ketua Departemen Pendidikan</div>
            <br><br><br>
            <div style="font-weight:700;">( _________________________ )</div>
          </div>
        </div>
      </div>`;

      await global.html2pdf().set({
        margin: 8,
        filename: `Laporan_Resmi_${actText.replace(/\s+/g, '_')}_${getTodayWib()}.pdf`,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, backgroundColor: '#ffffff', useCORS: true, scrollY: 0 },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
      }).from(htmlStr).save();

      if (typeof global.Swal !== 'undefined') global.Swal.close();
    } catch (e) {
      if (typeof global.Swal !== 'undefined') global.Swal.fire('Gagal', 'Pustaka PDF belum siap.', 'error');
    }
  }

  // ===================== 5. BERANDA ADAPTIF PERAN (SOFT BENTO + PERINGATAN + WALI SANTRI) =====================
  function resolveStaffAssignment(sess) {
    if (!sess) return { type: '', label: '', targets: [], memberNamesSet: new Set() };
    const nameNorm = normText(sess.name);
    const md = global.masterData || {};
    const cd = global.coreData || {};

    if (sess.role === 'musyrif') {
      const roomsSet = new Map();
      const pushRoom = (raw) => {
        String(raw || '').split(',').forEach(part => {
          const clean = part.trim();
          if (!clean) return;
          const tok = normalizeTargetToken(clean);
          if (tok && !roomsSet.has(tok)) roomsSet.set(tok, clean);
        });
      };
      // Prioritaskan kamar langsung dari sesi login Musyrif, lalu lengkapi dari masterData/coreData
      if (sess.kamar) pushRoom(sess.kamar);
      const list = (md.musyrifs || []).concat(cd.musyrifs || []);
      list.filter(m => m && normText(m.nama) === nameNorm).forEach(m => pushRoom(m.kamar));

      const rooms = Array.from(roomsSet.values());
      const memberNamesSet = new Set();
      if (rooms.length && Array.isArray(cd.santriWB)) {
        cd.santriWB.forEach(s => {
          if (s && typeof s === 'object' && targetMatchesAny(s.kamar, rooms)) {
            const nm = normText(s.nama);
            if (nm) memberNamesSet.add(nm);
          }
        });
      }
      const label = rooms.length
        ? rooms.map(r => /^kamar\s+/i.test(r) ? r : ('Kamar ' + r)).join(', ')
        : 'Kamar Belum Tertaut';
      return { type: 'wb', label: label, targets: rooms, memberNamesSet: memberNamesSet };
    }

    if (sess.role === 'pengajar') {
      const classSet = new Map();
      const pushClass = (raw) => {
        const clean = String(raw || '').trim();
        if (!clean) return;
        const tok = normalizeTargetToken(clean);
        if (tok && !classSet.has(tok)) classSet.set(tok, clean);
      };
      // Prioritaskan kelas & qismu langsung dari sesi login Pengajar (persis seperti dropdown absensi)
      if (sess.kelas) {
        const kArr = String(sess.kelas).split(',').map(k => k.trim()).filter(Boolean);
        const qArr = sess.qismu ? String(sess.qismu).split(',').map(q => q.trim()).filter(Boolean) : [];
        kArr.forEach((k, i) => {
          const q = qArr[i] || qArr[0] || '';
          pushClass(q ? `${k} - ${q}` : k);
        });
      }
      const list = (md.pengajars || []).concat(cd.pengajars || []);
      list.filter(p => p && normText(p.nama) === nameNorm).forEach(p => {
        if (p.kelas) {
          const kArr = String(p.kelas).split(',').map(k => k.trim()).filter(Boolean);
          const qArr = p.qismu ? String(p.qismu).split(',').map(q => q.trim()).filter(Boolean) : [];
          kArr.forEach((k, i) => {
            const q = qArr[i] || qArr[0] || '';
            pushClass(q ? `${k} - ${q}` : k);
          });
        }
      });

      const classes = Array.from(classSet.values());
      const memberNamesSet = new Set();
      if (classes.length && Array.isArray(cd.santriTakhassus)) {
        cd.santriTakhassus.forEach(s => {
          if (s && typeof s === 'object') {
            const fullCls = [s.kelas, s.qismu].filter(Boolean).join(' - ').trim();
            if (targetMatchesAny(fullCls, classes) || targetMatchesAny(s.kelas, classes)) {
              const nm = normText(s.nama);
              if (nm) memberNamesSet.add(nm);
            }
          }
        });
      }
      const label = classes.length ? classes.join(', ') : 'Kelas Belum Tertaut';
      return { type: 'takhassus', label: label, targets: classes, memberNamesSet: memberNamesSet };
    }

    return { type: '', label: '', targets: [], memberNamesSet: new Set() };
  }

  function computeDeadlineCountdown(actType) {
    const dlMap = (global.AlRifaieAdminSettings && typeof global.AlRifaieAdminSettings.loadDeadlines === 'function')
      ? global.AlRifaieAdminSettings.loadDeadlines()
      : { wb: { enabled: true, time: '20:15' }, takhassus: { enabled: true, time: '16:15' } };
    const cfg = dlMap[actType];
    if (!cfg || !cfg.enabled || !cfg.time) return { enabled: false, text: 'Tanpa batas waktu', urgent: false, passed: false, time: '' };
    const parts = cfg.time.split(':');
    const hh = parseInt(parts[0], 10);
    const mm = parseInt(parts[1], 10);
    if (isNaN(hh) || isNaN(mm)) return { enabled: false, text: '-', urgent: false, passed: false, time: cfg.time };
    const now = getWibNowMinutes();
    const diff = (hh * 60 + mm) - now.totalMin;
    if (diff > 60) {
      const h = Math.floor(diff / 60);
      const m = diff % 60;
      return { enabled: true, text: `${h} jam ${m} mnt lagi`, urgent: false, passed: false, time: cfg.time, diffMin: diff };
    }
    if (diff > 0) {
      return { enabled: true, text: `${diff} menit lagi`, urgent: diff <= 10, passed: false, time: cfg.time, diffMin: diff };
    }
    return { enabled: true, text: `Lewat ${Math.abs(diff)} mnt`, urgent: false, passed: true, time: cfg.time, diffMin: diff };
  }

  function startQuickScanForStaff(actType, targetValue) {
    if (typeof global.switchTab === 'function') global.switchTab(actType);
    setTimeout(() => {
      if (actType === 'wb' && targetValue) {
        const sel = document.getElementById('wbRoomSelect');
        if (sel && Array.from(sel.options).some(o => o.value === targetValue)) {
          sel.value = targetValue;
          if (typeof global.loadMembers === 'function') global.loadMembers('wb');
        }
      } else if (actType === 'takhassus' && targetValue) {
        const sel = document.getElementById('takhClassSelect');
        if (sel && Array.from(sel.options).some(o => o.value === targetValue)) {
          sel.value = targetValue;
          if (typeof global.loadMembers === 'function') global.loadMembers('takhassus');
        }
      }
      if (global.AlRifaieAttendance && typeof global.AlRifaieAttendance.openQrScanner === 'function') {
        global.AlRifaieAttendance.openQrScanner('attendance', actType);
      }
    }, 220);
  }

  function openTindakanSheet(namaSantri, kamarKelas, issueSummary) {
    const sess = global.session || {};
    const canCreateSurat = sess.role === 'admin' || (Array.isArray(sess.permissions) && (sess.permissions.includes('ALL') || sess.permissions.includes('surat')));
    const roleLabel = sess.role === 'musyrif' ? 'Musyrif' : (sess.role === 'pengajar' ? 'Pengajar' : 'Pengurus');
    const recentLogs = (tindakanListCache.length ? tindakanListCache : readLocalTindakan())
      .filter(t => normText(t.namaSantri) === normText(namaSantri))
      .slice(0, 4);

    const historyHtml = recentLogs.length
      ? `<div class="space-y-1.5 pt-2 border-t border-slate-100 dark:border-slate-800">
          <div class="text-[10px] font-bold uppercase text-slate-400">Riwayat Tindakan Sebelumnya</div>
          ${recentLogs.map(r => `<div class="p-2 rounded-xl bg-slate-50 dark:bg-slate-800/60 text-[11px]">
            <div class="flex justify-between font-bold text-slate-700 dark:text-slate-200"><span>${escHtml(r.tindakan)}</span><span class="text-[10px] text-slate-400">${escHtml(r.tanggal)}</span></div>
            ${r.catatan ? `<p class="text-slate-500 mt-0.5">${escHtml(r.catatan)}</p>` : ''}
          </div>`).join('')}
        </div>`
      : '';

    const safeNama = escJsAttr(namaSantri);
    const bodyHtml = `<form onsubmit="window.AlRifaieSmart.saveTindakanForm(event)" class="space-y-3">
      <input type="hidden" id="tndNamaSantri" value="${escHtml(namaSantri)}">
      <input type="hidden" id="tndKamarKelas" value="${escHtml(kamarKelas)}">
      <div class="p-3 rounded-xl bg-red-50/85 dark:bg-red-950/35 border border-red-200/80 dark:border-red-900/60 text-xs space-y-1">
        <div class="font-extrabold text-red-700 dark:text-red-300"><i class="fa-solid fa-triangle-exclamation mr-1"></i>Peringatan Pembinaan (${escHtml(roleLabel)})</div>
        <div class="text-slate-700 dark:text-slate-200">${escHtml(issueSummary || 'Memerlukan pembinaan kedisiplinan')}</div>
        <div class="text-[10.5px] text-red-600/90 dark:text-red-300/90">Berikan tindakan langsung kepada santri lalu simpan catatannya di bawah ini.</div>
      </div>
      <div>
        <label class="block text-xs font-bold text-slate-700 dark:text-slate-200 mb-1">Tindakan yang Diberikan</label>
        <select id="tndJenis" class="clean-input w-full px-3 py-2.5 text-xs font-semibold" required>
          <option value="Teguran Lisan & Nasihat">Teguran Lisan &amp; Nasihat</option>
          <option value="Pembinaan Personal di Kamar/Kelas">Pembinaan Personal di Kamar/Kelas</option>
          <option value="Hukuman Edukatif / Takzir Ringan">Hukuman Edukatif / Takzir Ringan</option>
          <option value="Koordinasi dengan Wali Santri">Koordinasi dengan Wali Santri</option>
          <option value="Dilaporkan ke Departemen Pendidikan (Pengajuan SP)">Dilaporkan ke Departemen Pendidikan (Pengajuan SP)</option>
        </select>
      </div>
      <div>
        <label class="block text-xs font-bold text-slate-700 dark:text-slate-200 mb-1">Catatan Hasil Pembinaan (Opsional)</label>
        <textarea id="tndCatatan" rows="2" placeholder="Cth: Santri sudah dinasihati, diberi takzir edukatif, dan berjanji hadir tepat waktu..." class="clean-input w-full px-3 py-2 text-xs"></textarea>
      </div>
      <div class="flex gap-2 pt-1">
        ${canCreateSurat ? `<button type="button" onclick="window.AlRifaieSmart.closeBottomSheet(); window.AlRifaieSmart.openSuratDisiplinForPerson('santri','${safeNama}')" class="px-3 py-2.5 rounded-xl bg-red-50 dark:bg-red-950/60 text-red-700 dark:text-red-300 text-xs font-bold inline-flex items-center gap-1"><i class="fa-solid fa-file-signature"></i><span>Buat SP</span></button>` : ''}
        <button type="submit" class="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-indigo-600 to-emerald-600 text-white text-xs font-bold shadow-md">Simpan Tindakan Pembinaan</button>
      </div>
      ${historyHtml}
    </form>`;

    openBottomSheet('Beri Tindakan Santri', `${namaSantri} • ${kamarKelas}`, bodyHtml, '');
  }

  function notifyStaffProblematicSantriAlert(role, staffName, assignLabel, problematicList) {
    if (!Array.isArray(problematicList) || !problematicList.length) return;
    try {
      const today = getTodayWib();
      const roleLabel = role === 'musyrif' ? 'Musyrif' : 'Pengajar';
      const namesSig = problematicList.slice(0, 3).map(p => normText(p.nama)).join(',');
      const alertKey = `${today}|${role}|${normText(staffName)}|${problematicList.length}|${namesSig}`;
      const storeKey = 'alrifaie_staff_problem_alert_v1';
      if (localStorage.getItem(storeKey) === alertKey) return;
      localStorage.setItem(storeKey, alertKey);

      const topNames = problematicList.slice(0, 3).map(p => p.nama).join(', ')
        + (problematicList.length > 3 ? ` dan ${problematicList.length - 3} santri lainnya` : '');
      const title = `Peringatan untuk ${roleLabel} (${problematicList.length} Santri)`;
      const body = `Mohon segera berikan peringatan kepada ${topNames} (${assignLabel}).`;

      if (global.AndroidBridge && typeof global.AndroidBridge.notifyRealtimeEvent === 'function') {
        global.AndroidBridge.notifyRealtimeEvent(title, body);
      }
    } catch (e) {}
  }

  function saveTindakanForm(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    const sess = global.session || {};
    const namaSantri = (document.getElementById('tndNamaSantri')?.value || '').trim();
    const kamarKelas = (document.getElementById('tndKamarKelas')?.value || '').trim();
    const tindakan = (document.getElementById('tndJenis')?.value || '').trim();
    const catatan = (document.getElementById('tndCatatan')?.value || '').trim();
    if (!namaSantri || !tindakan) return;

    const id = 'tnd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const rec = {
      id: id,
      tanggal: getTodayWib(),
      namaSantri: namaSantri,
      kamarKelas: kamarKelas,
      tindakan: tindakan,
      catatan: catatan,
      petugas: sess.name || 'Petugas',
      peranPetugas: sess.role || '',
      localOnly: true
    };

    writeLocalTindakan([rec].concat(readLocalTindakan()));
    closeBottomSheet();
    renderRoleBentoDashboard();

    try {
      if (global.google && global.google.script && global.google.script.run && typeof global.google.script.run.saveSantriTindakan === 'function') {
        global.google.script.run
          .withSuccessHandler(res => {
            if (res && res.success) {
              const synced = readLocalTindakan().map(x => x.id === id ? Object.assign({}, x, { id: res.id || id, localOnly: false }) : x);
              writeLocalTindakan(synced);
            }
          })
          .withFailureHandler(() => {})
          .saveSantriTindakan(rec);
      }
    } catch (err) {}

    if (typeof global.Swal !== 'undefined') {
      global.Swal.fire({
        toast: true,
        position: 'top',
        icon: 'success',
        title: 'Tindakan untuk ' + namaSantri + ' tercatat',
        showConfirmButton: false,
        timer: 2200
      });
    }
  }

  function getLatestSyncedMissingToday() {
    const tgl = getTodayWib();
    const ym = tgl.slice(0, 7);
    if (typeof global.getCachedMissingEntry === 'function') {
      const cached = global.getCachedMissingEntry(tgl, ym);
      if (cached && cached.data) {
        return {
          wb: cached.data.wb || [],
          takhassus: cached.data.takhassus || [],
          riwayat: cached.data.riwayat || {},
          ts: cached.ts || 0
        };
      }
    }
    if (cachedMissingToday) return cachedMissingToday;
    if (typeof global.computeLocalMissingFallback === 'function') {
      const est = global.computeLocalMissingFallback(tgl, ym);
      if (est) {
        return {
          wb: est.wb || [],
          takhassus: est.takhassus || [],
          riwayat: est.riwayat || {},
          ts: 0
        };
      }
    }
    return null;
  }

  function syncMissingData(data, tgl) {
    if (!data || typeof data !== 'object') return;
    const today = getTodayWib();
    if (tgl && String(tgl).slice(0, 10) !== today) return;
    cachedMissingToday = {
      wb: Array.isArray(data.wb) ? data.wb.slice() : [],
      takhassus: Array.isArray(data.takhassus) ? data.takhassus.slice() : [],
      riwayat: (data.riwayat && typeof data.riwayat === 'object') ? data.riwayat : {},
      ts: Date.now()
    };
    if (global.session && (global.session.role === 'admin' || global.session.role === 'user')) {
      renderRoleBentoDashboard();
    }
    if (isBottomSheetOpen()) {
      const titleEl = document.getElementById('smartBottomSheetTitle');
      if (titleEl && titleEl.innerText.indexOf('Belum Absen') !== -1) {
        openMissingMonitorSheet();
      }
    }
  }

  function openMissingMonitorSheet() {
    const latest = getLatestSyncedMissingToday();
    if (latest) cachedMissingToday = latest;
    const data = latest || { wb: [], takhassus: [], riwayat: {} };
    const wbList = data.wb || [];
    const tkList = data.takhassus || [];
    const riwEntries = Object.entries(data.riwayat || {}).filter(x => Array.isArray(x[1]) && x[1].length > 0).sort((a, b) => b[1].length - a[1].length);
    const bodyHtml = `<div class="space-y-3">
      <div class="grid grid-cols-3 gap-2">
        <div class="p-2 rounded-xl bg-red-50 dark:bg-red-950/40 text-center">
          <div class="text-[9.5px] font-bold text-red-600 dark:text-red-300 uppercase">WB Hari Ini</div>
          <div class="text-base font-extrabold text-red-700 dark:text-red-200">${wbList.length}</div>
        </div>
        <div class="p-2 rounded-xl bg-indigo-50 dark:bg-indigo-950/40 text-center">
          <div class="text-[9.5px] font-bold text-indigo-600 dark:text-indigo-300 uppercase">Takhassus</div>
          <div class="text-base font-extrabold text-indigo-700 dark:text-indigo-200">${tkList.length}</div>
        </div>
        <div class="p-2 rounded-xl bg-amber-50 dark:bg-amber-950/40 text-center">
          <div class="text-[9.5px] font-bold text-amber-700 dark:text-amber-300 uppercase">Rekap Bulan</div>
          <div class="text-base font-extrabold text-amber-800 dark:text-amber-200">${riwEntries.length}</div>
        </div>
      </div>
      <div>
        <div class="text-[11px] font-extrabold uppercase text-red-600 mb-1.5 flex items-center justify-between">
          <span>Wajib Belajar Belum Absen</span>
          <span class="px-2 py-0.5 rounded-full bg-red-100 dark:bg-red-950/70 text-red-700 dark:text-red-300">${wbList.length}</span>
        </div>
        <div class="space-y-1.5">${wbList.length
          ? wbList.map(r => `<div class="p-2.5 rounded-xl bg-red-50/80 dark:bg-red-950/35 text-xs font-bold text-red-700 dark:text-red-300 flex items-center gap-2"><i class="fa-solid fa-door-open text-[11px]"></i><span>${escHtml(r)}</span></div>`).join('')
          : '<div class="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/35 text-xs font-bold text-emerald-700 dark:text-emerald-300"><i class="fa-solid fa-circle-check mr-1.5"></i>Semua kamar WB sudah absen hari ini!</div>'}</div>
      </div>
      <div>
        <div class="text-[11px] font-extrabold uppercase text-indigo-600 dark:text-indigo-400 mb-1.5 flex items-center justify-between">
          <span>Takhassus Belum Absen</span>
          <span class="px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-950/70 text-indigo-700 dark:text-indigo-300">${tkList.length}</span>
        </div>
        <div class="space-y-1.5">${tkList.length
          ? tkList.map(r => `<div class="p-2.5 rounded-xl bg-indigo-50/80 dark:bg-indigo-950/35 text-xs font-bold text-indigo-700 dark:text-indigo-300 flex items-center gap-2"><i class="fa-solid fa-chalkboard text-[11px]"></i><span>${escHtml(r)}</span></div>`).join('')
          : '<div class="p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/35 text-xs font-bold text-emerald-700 dark:text-emerald-300"><i class="fa-solid fa-circle-check mr-1.5"></i>Semua kelas Takhassus sudah absen hari ini!</div>'}</div>
      </div>
    </div>`;

    const footerHtml = `<div class="flex gap-2">
      <button type="button" onclick="window.AlRifaieSmart.refreshMissingMonitor(true)" class="flex-1 py-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-bold text-slate-700 dark:text-slate-200"><i class="fa-solid fa-rotate-right mr-1"></i>Segarkan</button>
      <button type="button" onclick="window.AlRifaieSmart.closeBottomSheet(); switchTab('tunggakan')" class="flex-1 py-2.5 rounded-xl bg-indigo-600 text-white text-xs font-bold">Buka Pantauan Penuh</button>
    </div>`;

    openBottomSheet('Monitor Belum Absen Hari Ini', formatIndoDate(getTodayWib()), bodyHtml, footerHtml);
  }

  let lastHomeMissingRefreshAt = 0;

  function refreshMissingMonitor(reopenSheet) {
    const tgl = getTodayWib();
    const ym = tgl.slice(0, 7);
    lastHomeMissingRefreshAt = Date.now();

    // Tampilkan data cache/rekap secara instan agar kartu monitor di beranda langsung terisi & sinkron
    const instant = getLatestSyncedMissingToday();
    if (instant) {
      cachedMissingToday = instant;
      renderRoleBentoDashboard();
    }

    if (typeof global.fetchMissingAttendanceFast === 'function') {
      global.fetchMissingAttendanceFast(tgl, ym, { forceRefresh: Boolean(reopenSheet) })
        .then(res => {
          if (res && typeof res === 'object') {
            cachedMissingToday = { wb: res.wb || [], takhassus: res.takhassus || [], riwayat: res.riwayat || {}, ts: Date.now() };
            renderRoleBentoDashboard();
            if (reopenSheet && isBottomSheetOpen()) openMissingMonitorSheet();
          }
        })
        .catch(() => {
          // Fallback diam-diam lewat Rekap agar Beranda tidak pernah stuck "..."
          Promise.all([fetchRekapCached('wb'), fetchRekapCached('takhassus')]).then(() => {
            const est = getLatestSyncedMissingToday();
            if (est) {
              cachedMissingToday = est;
              renderRoleBentoDashboard();
              if (reopenSheet && isBottomSheetOpen()) openMissingMonitorSheet();
            }
          });
        });
      return;
    }

    if (global.google && global.google.script && global.google.script.run && typeof global.google.script.run.getMissingAttendance === 'function') {
      global.google.script.run
        .withSuccessHandler(res => {
          if (res && typeof res === 'object' && !res.error) {
            cachedMissingToday = { wb: res.wb || [], takhassus: res.takhassus || [], riwayat: res.riwayat || {}, ts: Date.now() };
            renderRoleBentoDashboard();
            if (reopenSheet && isBottomSheetOpen()) openMissingMonitorSheet();
          }
        })
        .withFailureHandler(() => {})
        .getMissingAttendance(tgl, ym);
    }
  }

  function buildWaliMiniCalendarHtml(childRecords) {
    const today = getTodayWib();
    const [yrStr, moStr] = today.split('-');
    const year = parseInt(yrStr, 10);
    const month = parseInt(moStr, 10);
    const daysInMonth = new Date(year, month, 0).getDate();

    const dayStatus = {};
    (childRecords || []).forEach(r => {
      const tgl = String(r.tanggal || '');
      if (!tgl.startsWith(`${yrStr}-${moStr}`)) return;
      const dNum = parseInt(tgl.slice(8, 10), 10);
      if (isNaN(dNum)) return;
      const k = String(r.kehadiran || '').toLowerCase();
      // Prioritas warna: Alpa > Izin > Hadir
      if (k === 'alpa') dayStatus[dNum] = 'alpa';
      else if (k === 'izin' && dayStatus[dNum] !== 'alpa') dayStatus[dNum] = 'izin';
      else if (k === 'hadir' && !dayStatus[dNum]) dayStatus[dNum] = 'hadir';
    });

    const cells = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const st = dayStatus[d];
      const cls = st === 'hadir'
        ? 'bg-emerald-500 text-white font-bold shadow-xs'
        : (st === 'izin'
          ? 'bg-amber-400 text-amber-950 font-bold'
          : (st === 'alpa'
            ? 'bg-red-500 text-white font-bold'
            : 'bg-slate-100 dark:bg-slate-800/80 text-slate-400'));
      cells.push(`<div class="h-7 rounded-lg text-[10px] flex items-center justify-center ${cls}">${d}</div>`);
    }

    return `<div class="space-y-2">
      <div class="flex items-center justify-between">
        <span class="text-[11px] font-bold text-slate-700 dark:text-slate-200">Kalender Kehadiran Bulan Ini</span>
        <div class="flex items-center gap-2 text-[9.5px] font-semibold text-slate-500">
          <span class="inline-flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-emerald-500"></span>Hadir</span>
          <span class="inline-flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-amber-400"></span>Izin</span>
          <span class="inline-flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-red-500"></span>Alpa</span>
        </div>
      </div>
      <div class="grid grid-cols-7 gap-1">${cells.join('')}</div>
    </div>`;
  }

  function renderRoleBentoDashboard() {
    const root = document.getElementById('roleBentoRoot');
    const sess = global.session;
    if (!root || !sess) return;

    const role = sess.role;
    const todayYm = getTodayWib().slice(0, 7);

    // Trigger background data fetch once per login session
    const roleKey = `${role}|${sess.name || ''}|${sess.namaSantri || ''}`;
    if (lastBentoLoadedRoleKey !== roleKey && !bentoDataLoading) {
      lastBentoLoadedRoleKey = roleKey;
      bentoDataLoading = true;
      loadIzinDigital();
      loadSantriTindakan();
      if (role === 'admin' || role === 'user') {
        refreshMissingMonitor(false);
        bentoDataLoading = false;
      } else if (role === 'musyrif') {
        fetchRekapCached('wb').then(() => { bentoDataLoading = false; renderRoleBentoDashboard(); });
      } else if (role === 'pengajar') {
        fetchRekapCached('takhassus').then(() => { bentoDataLoading = false; renderRoleBentoDashboard(); });
      } else if (role === 'walisantri') {
        Promise.all([fetchRekapCached('wb'), fetchRekapCached('takhassus')]).then(() => {
          bentoDataLoading = false;
          renderRoleBentoDashboard();
        });
      } else {
        bentoDataLoading = false;
      }
    }

    // ===== 1. BERANDA WALI SANTRI (1 AKUN BERSAMA + SEARCHING NAMA ANAK) =====
    if (role === 'walisantri') {
      const dir = getSearchableWaliSantriDirectory();
      const savedChild = getSavedWaliChildName();
      const selectedChildName = savedChild || String(sess.namaSantri || '').trim();
      const childNorm = normText(selectedChildName);
      const matchedChild = childNorm
        ? dir.find(s => normText(s.nama) === childNorm) || dir.find(s => normText(s.nama).includes(childNorm) || childNorm.includes(normText(s.nama)))
        : null;
      const displayChildName = matchedChild ? matchedChild.nama : selectedChildName;
      const hasSelectedChild = Boolean(displayChildName);
      const childMeta = matchedChild
        ? [matchedChild.kamar ? ('Kamar ' + matchedChild.kamar) : '', matchedChild.kelas].filter(Boolean).join(' • ') || 'Santri YPM Al-Rifa\'ie 2'
        : 'Santri YPM Al-Rifa\'ie 2';

      const wbRows = (global.rekCache && global.rekCache.wb) || [];
      const tkRows = (global.rekCache && global.rekCache.takhassus) || [];
      const allChildRecs = hasSelectedChild
        ? wbRows.concat(tkRows).filter(r => {
            const rn = normText(r.nama);
            const target = normText(displayChildName);
            if (!target || !rn) return false;
            return (rn === target || rn.includes(target) || target.includes(rn)) && String(r.tanggal || '').startsWith(todayYm);
          })
        : [];

      let cH = 0, cI = 0, cA = 0;
      const pelNotes = [];
      allChildRecs.forEach(r => {
        const k = String(r.kehadiran || '').toLowerCase();
        if (k === 'hadir') cH++;
        else if (k === 'izin') cI++;
        else cA++;
        if (r.pelanggaran && String(r.pelanggaran).trim()) {
          pelNotes.push({ tanggal: r.tanggal, ket: r.pelanggaran });
        }
      });

      const canViewRekap = typeof global.hasPerm === 'function' ? global.hasPerm('rekap') : true;

      root.innerHTML = `<div class="space-y-3">
        <!-- Kartu Pencarian Nama Anak (Berlaku untuk 1 Akun Bersama Wali Santri) -->
        <div class="bento-card p-4 border border-emerald-200/80 dark:border-emerald-900/50 bg-gradient-to-br from-emerald-50/75 via-white to-teal-50/40 dark:from-emerald-950/35 dark:via-slate-900 dark:to-teal-950/20 space-y-3">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2.5 min-w-0">
              <div class="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white flex items-center justify-center shadow-sm shrink-0">
                <i class="fa-solid fa-magnifying-glass text-xs"></i>
              </div>
              <div class="min-w-0">
                <h3 class="text-xs sm:text-sm font-extrabold text-slate-900 dark:text-white">Cari Nama Putra / Putri Anda</h3>
                <p class="text-[10.5px] text-slate-500 dark:text-slate-400">Ketik nama santri untuk memantau kehadiran &amp; catatan pembinaan (${dir.length} santri terdaftar)</p>
              </div>
            </div>
            ${hasSelectedChild ? `<button type="button" onclick="window.AlRifaieSmart.clearWaliChildSelection()" class="px-2.5 py-1.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-[10.5px] font-bold text-slate-600 dark:text-slate-300 hover:text-emerald-600 shrink-0"><i class="fa-solid fa-rotate mr-1"></i>Ganti Anak</button>` : ''}
          </div>
          <div class="relative">
            <i class="fa-solid fa-user-graduate text-emerald-500 text-xs absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"></i>
            <input type="text" id="waliChildSearchInput" value="${escHtml(hasSelectedChild ? '' : waliChildSearchQuery)}" oninput="window.AlRifaieSmart.onWaliChildSearchInput(this.value)" placeholder="Ketik nama anak (misal: Ahmad, Muhammad, Fauzan)..." autocomplete="off" class="clean-input w-full pl-9 pr-9 py-2.5 text-xs font-semibold">
            <button type="button" onclick="window.AlRifaieSmart.onWaliChildSearchInput(''); const el=document.getElementById('waliChildSearchInput'); if(el){el.value=''; el.focus();}" aria-label="Bersihkan pencarian" class="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-lg text-slate-400 hover:text-slate-600 flex items-center justify-center"><i class="fa-solid fa-xmark text-xs"></i></button>
          </div>
          <div id="waliChildSearchResults" class="space-y-1.5"></div>
        </div>

        ${hasSelectedChild ? `<div class="bento-card p-4 border-l-4 border-l-emerald-600 space-y-3.5">
          <div class="flex items-start justify-between gap-3 flex-wrap">
            <div class="flex items-center gap-3 min-w-0">
              <div class="w-12 h-12 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white flex items-center justify-center text-lg shadow-md shrink-0">
                <i class="fa-solid fa-user-graduate"></i>
              </div>
              <div class="min-w-0">
                <span class="text-[10px] font-extrabold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">Monitoring Santri Bulan Ini</span>
                <h3 class="text-sm font-extrabold text-slate-900 dark:text-white truncate">${escHtml(displayChildName)}</h3>
                <p class="text-[11px] text-slate-500 truncate">${escHtml(childMeta)}</p>
              </div>
            </div>
            ${canViewRekap ? `<button type="button" onclick="window.AlRifaieSmart.openRekapForWaliChild('${escJsAttr(displayChildName)}')" class="px-3 py-1.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 text-[11px] font-bold hover:bg-emerald-100 inline-flex items-center gap-1.5 shrink-0"><i class="fa-solid fa-chart-pie text-[10px]"></i><span>Lihat Rekap Lengkap</span></button>` : ''}
          </div>

          <div class="grid grid-cols-3 gap-2">
            <div class="p-2.5 rounded-2xl bg-emerald-50/90 dark:bg-emerald-950/40 text-center">
              <div class="text-[10px] font-bold text-emerald-700 dark:text-emerald-300 uppercase">Hadir</div>
              <div class="text-lg font-extrabold text-emerald-800 dark:text-emerald-200">${cH}</div>
            </div>
            <div class="p-2.5 rounded-2xl bg-amber-50/90 dark:bg-amber-950/40 text-center">
              <div class="text-[10px] font-bold text-amber-700 dark:text-amber-300 uppercase">Izin</div>
              <div class="text-lg font-extrabold text-amber-800 dark:text-amber-200">${cI}</div>
            </div>
            <div class="p-2.5 rounded-2xl bg-red-50/90 dark:bg-red-950/40 text-center">
              <div class="text-[10px] font-bold text-red-700 dark:text-red-300 uppercase">Alpa</div>
              <div class="text-lg font-extrabold text-red-800 dark:text-red-200">${cA}</div>
            </div>
          </div>

          ${buildWaliMiniCalendarHtml(allChildRecs)}

          ${pelNotes.length ? `<div class="p-2.5 rounded-xl bg-amber-50/80 dark:bg-amber-950/30 border border-amber-200/70 dark:border-amber-800/50 text-[11px] space-y-1">
            <div class="font-bold text-amber-800 dark:text-amber-300"><i class="fa-solid fa-note-sticky mr-1"></i>Catatan Pembinaan Terbaru:</div>
            ${pelNotes.slice(0, 3).map(p => `<div class="text-slate-700 dark:text-slate-200">&bull; <b>${escHtml(p.tanggal)}</b>: ${escHtml(p.ket)}</div>`).join('')}
          </div>` : ''}
        </div>` : `<div class="bento-card p-5 text-center space-y-2 border border-dashed border-emerald-300/80 dark:border-emerald-800/60">
          <div class="w-11 h-11 rounded-2xl bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center mx-auto text-lg">
            <i class="fa-solid fa-magnifying-glass-chart"></i>
          </div>
          <div class="text-xs font-bold text-slate-800 dark:text-slate-200">Silakan Cari Nama Putra / Putri Anda di Atas</div>
          <p class="text-[11px] text-slate-500 max-w-sm mx-auto">Ketik minimal 2 huruf nama santri lalu pilih dari daftar hasil pencarian untuk melihat kehadiran bulan ini, kalender harian, dan catatan pembinaan.</p>
        </div>`}
      </div>`;

      if (!hasSelectedChild && waliChildSearchQuery) {
        onWaliChildSearchInput(waliChildSearchQuery);
      }
      return;
    }

    // ===== 2. BERANDA MUSYRIF & PENGAJAR (TERKUNCI KETAT KE KAMAR/KELAS & HANYA INFORMASI SANTRI BERMASALAH) =====
    if (role === 'musyrif' || role === 'pengajar') {
      const assign = resolveStaffAssignment(sess);
      const actType = assign.type || (role === 'musyrif' ? 'wb' : 'takhassus');
      const primaryTarget = assign.targets[0] || '';
      const dlInfo = computeDeadlineCountdown(actType);
      const rekRows = (global.rekCache && global.rekCache[actType]) || [];
      const monthRows = rekRows.filter(r => String(r.tanggal || '').startsWith(todayYm));

      // TERKUNCI KETAT: Hanya menampilkan santri di kamar/kelas yang dipegang oleh musyrif/pengajar ini (TIDAK pernah menampilkan semua santri)
      const hasLockedAssignment = assign.targets.length > 0;
      const scopedRows = hasLockedAssignment
        ? monthRows.filter(r => {
            const byTarget = targetMatchesAny(r.target, assign.targets);
            const byMember = assign.memberNamesSet && assign.memberNamesSet.size > 0 && assign.memberNamesSet.has(normText(r.nama));
            return byTarget || byMember;
          })
        : [];

      const problemMap = {};
      scopedRows.forEach(r => {
        const nama = String(r.nama || '').trim();
        if (!nama) return;
        const keh = String(r.kehadiran || '').toLowerCase();
        const pel = String(r.pelanggaran || '').trim();
        const isAlpa = keh === 'alpa' || (keh !== 'hadir' && keh !== 'izin' && keh !== '');
        if (!isAlpa && !pel) return;
        const key = normText(nama);
        if (!problemMap[key]) {
          problemMap[key] = {
            nama: nama,
            kamar: String(r.target || assign.label).trim(),
            alpa: 0,
            alpaDates: [],
            pelList: []
          };
        }
        if (isAlpa) {
          problemMap[key].alpa++;
          if (r.tanggal) problemMap[key].alpaDates.push(String(r.tanggal).slice(0, 10));
        }
        if (pel) problemMap[key].pelList.push(pel);
      });

      const problematicList = Object.values(problemMap)
        .sort((a, b) => (b.alpa * 2 + b.pelList.length) - (a.alpa * 2 + a.pelList.length) || a.nama.localeCompare(b.nama));

      const roleTitle = role === 'musyrif' ? 'Musyrif' : 'Pengajar';

      if (hasLockedAssignment && problematicList.length > 0) {
        notifyStaffProblematicSantriAlert(role, sess.name || roleTitle, assign.label, problematicList);
      }

      let alertHtml = '';
      if (!hasLockedAssignment) {
        alertHtml = `<div class="bento-card p-3.5 flex items-center gap-3 border border-amber-200/80 dark:border-amber-900/60 bg-amber-50/60 dark:bg-amber-950/25">
          <div class="w-9 h-9 rounded-xl bg-amber-500 text-white flex items-center justify-center shrink-0"><i class="fa-solid fa-lock text-sm"></i></div>
          <div class="min-w-0">
            <div class="text-xs font-bold text-amber-800 dark:text-amber-300">${role === 'musyrif' ? 'Kamar Binaan' : 'Kelas Binaan'} Belum Tertaut</div>
            <div class="text-[11px] text-slate-500">Pemberitahuan santri bermasalah terkunci otomatis per ${role === 'musyrif' ? 'kamar' : 'kelas'}. Hubungi Admin jika belum muncul.</div>
          </div>
        </div>`;
      } else if (problematicList.length) {
        alertHtml = `<div class="bento-card p-4 border-l-4 border-l-red-500 bg-gradient-to-br from-red-50/80 via-white to-amber-50/45 dark:from-red-950/35 dark:via-slate-900 dark:to-amber-950/20 space-y-3">
          <div class="flex items-start justify-between gap-2 flex-wrap">
            <div class="flex items-center gap-2.5 min-w-0">
              <div class="w-10 h-10 rounded-2xl bg-red-600 text-white flex items-center justify-center shrink-0 shadow-sm">
                <i class="fa-solid fa-bell text-sm"></i>
              </div>
              <div class="min-w-0">
                <h3 class="text-xs sm:text-sm font-extrabold text-red-700 dark:text-red-300">Peringatan untuk ${roleTitle} (${problematicList.length} Santri)</h3>
                <p class="text-[11px] text-slate-600 dark:text-slate-300">Mohon segera berikan peringatan dan pembinaan kepada santri binaan di bawah ini.</p>
              </div>
            </div>
            <span class="px-2.5 py-1 rounded-full text-[10px] font-bold bg-indigo-50 dark:bg-indigo-950/70 text-indigo-700 dark:text-indigo-300 border border-indigo-200/70 dark:border-indigo-800/60 inline-flex items-center gap-1 shrink-0">
              <i class="fa-solid fa-lock text-[9px]"></i>
              <span>${escHtml(assign.label)}</span>
            </span>
          </div>
          <div class="px-3 py-2 rounded-xl bg-amber-100/80 dark:bg-amber-950/50 border border-amber-300/70 dark:border-amber-800/60 text-[11px] font-semibold text-amber-900 dark:text-amber-200 flex items-center gap-2">
            <i class="fa-solid fa-triangle-exclamation text-amber-600 dark:text-amber-400 shrink-0"></i>
            <span>Kepada ${roleTitle}, harap segera memberi peringatan secara langsung kepada santri berikut agar lebih tertib dan tidak mengulangi pelanggaran.</span>
          </div>
          <div class="space-y-2 max-h-72 overflow-y-auto pr-0.5">
            ${problematicList.map(p => {
              const latestDates = p.alpaDates.slice(-3).reverse().join(', ');
              return `<div class="p-3 rounded-2xl bg-white/95 dark:bg-slate-900/85 border border-red-200/75 dark:border-red-900/55 space-y-1">
                <div class="flex items-center justify-between gap-2">
                  <span class="text-xs font-extrabold text-slate-900 dark:text-white truncate">${escHtml(p.nama)}</span>
                  <div class="flex items-center gap-1 shrink-0">
                    ${p.alpa > 0 ? `<span class="px-2 py-0.5 rounded-full text-[9.5px] font-extrabold bg-red-100 dark:bg-red-950/70 text-red-700 dark:text-red-300">${p.alpa}x Alpa</span>` : ''}
                    ${p.pelList.length > 0 ? `<span class="px-2 py-0.5 rounded-full text-[9.5px] font-extrabold bg-amber-100 dark:bg-amber-950/70 text-amber-800 dark:text-amber-300">${p.pelList.length} Pelanggaran</span>` : ''}
                  </div>
                </div>
                <div class="text-[10.5px] text-slate-500 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span><i class="fa-solid fa-door-open mr-1 text-[9px]"></i>${escHtml(p.kamar)}</span>
                  ${latestDates ? `<span>&bull; Tgl Alpa: <b>${escHtml(latestDates)}</b></span>` : ''}
                </div>
                ${p.pelList.length > 0 ? `<div class="text-[10.5px] text-amber-700 dark:text-amber-300 font-semibold"><i class="fa-solid fa-triangle-exclamation mr-1 text-[9px]"></i>${escHtml(p.pelList.slice(0, 3).join(', '))}</div>` : ''}
                <div class="text-[10.5px] font-semibold text-rose-700 dark:text-rose-300 pt-0.5"><i class="fa-solid fa-circle-info mr-1 text-[9px]"></i>Mohon segera diberi peringatan oleh ${roleTitle.toLowerCase()}.</div>
              </div>`;
            }).join('')}
          </div>
        </div>`;
      } else {
        alertHtml = `<div class="bento-card p-3.5 flex items-center justify-between gap-3 border border-emerald-200/70 dark:border-emerald-900/50 bg-emerald-50/50 dark:bg-emerald-950/20">
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-9 h-9 rounded-xl bg-emerald-600 text-white flex items-center justify-center shrink-0"><i class="fa-solid fa-shield-heart text-sm"></i></div>
            <div class="min-w-0">
              <div class="text-xs font-bold text-emerald-800 dark:text-emerald-300">Kondisi ${escHtml(assign.label)} Aman &amp; Tertib</div>
              <div class="text-[11px] text-slate-500">Belum ada santri bermasalah (alpa/pelanggaran) bulan ini pada ${role === 'musyrif' ? 'kamar' : 'kelas'} Anda.</div>
            </div>
          </div>
          <span class="px-2 py-0.5 rounded-full text-[9.5px] font-bold bg-emerald-100 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-300 shrink-0"><i class="fa-solid fa-lock mr-1"></i>Terkunci</span>
        </div>`;
      }

      const safeTargetAttr = escJsAttr(primaryTarget);
      const deadlineCardCls = dlInfo.urgent
        ? 'border-amber-400 bg-amber-50/90 dark:bg-amber-950/40'
        : (dlInfo.passed ? 'border-red-300/70 bg-red-50/60 dark:bg-red-950/30' : '');
      const showStaffIzinCard = hasAccessIzin();

      root.innerHTML = `<div class="space-y-3">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button type="button" onclick="window.AlRifaieSmart.startQuickScanForStaff('${actType}', '${safeTargetAttr}')" class="bento-card p-4 text-left bg-gradient-to-br from-emerald-600 via-teal-600 to-indigo-700 text-white border-0 shadow-lg hover:brightness-105 active:scale-[0.98] transition-all flex items-center justify-between gap-3">
            <div class="min-w-0">
              <span class="px-2 py-0.5 rounded-full bg-white/15 text-[9.5px] font-extrabold uppercase tracking-wider">Aksi Cepat 1 Ketukan</span>
              <div class="text-sm font-extrabold mt-1.5">Mulai Scan QR / Tap NFC</div>
              <div class="text-[11px] text-emerald-100 truncate mt-0.5">${actType === 'wb' ? 'Wajib Belajar' : 'Takhassus'} &bull; ${escHtml(assign.label)}</div>
            </div>
            <div class="w-12 h-12 rounded-2xl bg-white/15 border border-white/25 flex items-center justify-center text-xl shrink-0">
              <i class="fa-solid fa-qrcode"></i>
            </div>
          </button>

          <div class="bento-card p-4 flex items-center justify-between gap-3 ${deadlineCardCls}">
            <div class="min-w-0">
              <span class="text-[10px] font-extrabold uppercase tracking-wider text-slate-500">Batas Waktu Absen</span>
              <div id="bentoDeadlineCountdownText" class="text-base font-extrabold ${dlInfo.urgent ? 'text-amber-700 dark:text-amber-300' : (dlInfo.passed ? 'text-red-600 dark:text-red-400' : 'text-indigo-700 dark:text-indigo-300')} mt-0.5">${escHtml(dlInfo.text)}</div>
              <div class="text-[11px] text-slate-500 mt-0.5">Batas: <b>${escHtml(dlInfo.time || '-')} WIB</b></div>
            </div>
            <div class="flex flex-col items-end gap-1.5 shrink-0">
              <div class="w-10 h-10 rounded-2xl ${dlInfo.urgent ? 'bg-amber-500 text-white animate-bounce' : 'bg-indigo-50 dark:bg-indigo-950/70 text-indigo-600 dark:text-indigo-300'} flex items-center justify-center text-sm">
                <i class="fa-solid fa-stopwatch"></i>
              </div>
              ${showStaffIzinCard ? `<button type="button" onclick="window.AlRifaieSmart.openIzinFormSheet()" class="px-2.5 py-1 rounded-lg bg-emerald-50 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-300 text-[10px] font-bold inline-flex items-center gap-1 hover:bg-emerald-100 transition-colors"><i class="fa-solid fa-paper-plane text-[9px]"></i><span>Ajukan Izin</span></button>` : ''}
            </div>
          </div>
        </div>
        ${alertHtml}
      </div>`;
      return;
    }

    // ===== 3. BERANDA ADMIN & PENGURUS (SOFT BENTO OPERATIONAL KPI — TERSINKRON DENGAN REKAP & TUNGGAKAN) =====
    if (role === 'admin' || role === 'user') {
      const isAdmin = role === 'admin';
      const syncedMissing = getLatestSyncedMissingToday();
      if (syncedMissing) cachedMissingToday = syncedMissing;
      // Segarkan diam-diam di latar belakang jika data sudah > 90 detik saat membuka Beranda
      if ((Date.now() - lastHomeMissingRefreshAt) > 90000) {
        setTimeout(() => refreshMissingMonitor(false), 120);
      }

      const missingWb = cachedMissingToday ? (cachedMissingToday.wb || []).length : null;
      const missingTk = cachedMissingToday ? (cachedMissingToday.takhassus || []).length : null;
      const totalMissing = missingWb !== null ? (missingWb + missingTk) : '...';
      const missingSubLabel = missingWb !== null
        ? (totalMissing === 0 ? 'Semua Lengkap' : `WB ${missingWb} • TK ${missingTk}`)
        : 'Menyinkronkan...';
      const pendingIzin = (izinListCache.length ? izinListCache : readLocalIzin()).filter(x => x.status === 'Menunggu').length;
      let offlinePending = 0;
      try {
        if (global.AndroidBridge && typeof global.AndroidBridge.getPendingOfflineQueueJson === 'function') {
          const arr = JSON.parse(global.AndroidBridge.getPendingOfflineQueueJson() || '[]');
          offlinePending = Array.isArray(arr) ? arr.length : 0;
        }
      } catch (e) {}

      const canOpenAdmin = isAdmin || (typeof global.hasPerm === 'function' && global.hasPerm('admin'));
      const fourthTileHtml = canOpenAdmin
        ? `<button type="button" onclick="switchTab('admin'); setTimeout(() => window.AlRifaieAdminSettings && window.AlRifaieAdminSettings.switchAdminCategory('offline'), 120);" class="bento-card p-3.5 text-left hover:border-amber-400 active:scale-[0.98] transition-all">
            <div class="flex items-center justify-between">
              <span class="w-9 h-9 rounded-xl bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 flex items-center justify-center text-sm"><i class="fa-solid fa-cloud-arrow-up"></i></span>
              <span class="text-[10px] font-bold ${offlinePending > 0 ? 'text-amber-600' : 'text-emerald-600'}">${offlinePending > 0 ? 'Antrean' : 'Tersinkron'}</span>
            </div>
            <div class="text-xl font-extrabold text-slate-900 dark:text-white mt-2.5">${offlinePending}</div>
            <div class="text-[11px] font-bold text-slate-600 dark:text-slate-300">Data Offline</div>
          </button>`
        : `<button type="button" onclick="switchTab('tunggakan')" class="bento-card p-3.5 text-left hover:border-amber-400 active:scale-[0.98] transition-all">
            <div class="flex items-center justify-between">
              <span class="w-9 h-9 rounded-xl bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 flex items-center justify-center text-sm"><i class="fa-solid fa-list-check"></i></span>
              <span class="text-[10px] font-bold text-emerald-600">Pantau</span>
            </div>
            <div class="text-sm font-extrabold text-slate-900 dark:text-white mt-3 leading-tight">Pantauan</div>
            <div class="text-[11px] font-semibold text-slate-500">Status Harian</div>
          </button>`;

      root.innerHTML = `<div class="space-y-3">
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <button type="button" onclick="window.AlRifaieSmart.openMissingMonitorSheet()" class="bento-card p-3.5 text-left hover:border-red-400 active:scale-[0.98] transition-all">
            <div class="flex items-center justify-between">
              <span class="w-9 h-9 rounded-xl ${totalMissing === 0 ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400' : 'bg-red-50 dark:bg-red-950/60 text-red-600 dark:text-red-400'} flex items-center justify-center text-sm"><i class="fa-solid ${totalMissing === 0 ? 'fa-circle-check' : 'fa-clock-rotate-left'}"></i></span>
              <span class="text-[10px] font-bold ${totalMissing === 0 ? 'text-emerald-600' : 'text-slate-400'}">${escHtml(missingSubLabel)}</span>
            </div>
            <div class="text-xl font-extrabold text-slate-900 dark:text-white mt-2.5">${escHtml(String(totalMissing))}</div>
            <div class="text-[11px] font-bold text-slate-600 dark:text-slate-300">Belum Absen</div>
          </button>

          ${isAdmin ? `<button type="button" onclick="switchTab('izin')" class="bento-card p-3.5 text-left hover:border-emerald-400 active:scale-[0.98] transition-all">
            <div class="flex items-center justify-between">
              <span class="w-9 h-9 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center text-sm"><i class="fa-solid fa-file-circle-check"></i></span>
              ${pendingIzin > 0 ? '<span class="px-2 py-0.5 rounded-full bg-amber-500 text-white text-[9px] font-extrabold">Perlu ACC</span>' : '<span class="text-[10px] font-bold text-emerald-600">Aman</span>'}
            </div>
            <div class="text-xl font-extrabold text-slate-900 dark:text-white mt-2.5">${pendingIzin}</div>
            <div class="text-[11px] font-bold text-slate-600 dark:text-slate-300">Izin Musyrif/Pengajar</div>
          </button>` : ''}

          ${isAdmin ? `<button type="button" onclick="window.AlRifaieSmart.openSuratDisiplinForPerson('santri','')" class="bento-card p-3.5 text-left hover:border-indigo-400 active:scale-[0.98] transition-all">
            <div class="flex items-center justify-between">
              <span class="w-9 h-9 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-300 flex items-center justify-center text-sm"><i class="fa-solid fa-file-signature"></i></span>
              <span class="text-[10px] font-bold text-indigo-600 dark:text-indigo-400">PDF Admin</span>
            </div>
            <div class="text-sm font-extrabold text-slate-900 dark:text-white mt-3 leading-tight">Surat Alpa</div>
            <div class="text-[11px] font-semibold text-slate-500">Santri &amp; Musyrif</div>
          </button>` : ''}

          ${fourthTileHtml}
        </div>
      </div>`;
    }
  }

  // ===================== 6. PENGINGAT 10 MENIT SEBELUM BATAS WAKTU ABSEN =====================
  function checkInAppDeadlineReminder() {
    const sess = global.session;
    if (!sess || sess.role === 'walisantri') return;

    // Update countdown text if visible
    if (sess.role === 'musyrif' || sess.role === 'pengajar') {
      const actType = sess.role === 'musyrif' ? 'wb' : 'takhassus';
      const cdEl = document.getElementById('bentoDeadlineCountdownText');
      if (cdEl) {
        const info = computeDeadlineCountdown(actType);
        cdEl.innerText = info.text;
      }
    }

    const targets = sess.role === 'musyrif'
      ? [{ k: 'wb', label: 'Absensi Wajib Belajar' }, { k: 'musyrif', label: 'Absensi Musyrif' }]
      : (sess.role === 'pengajar'
        ? [{ k: 'takhassus', label: 'Absensi Takhassus' }, { k: 'pengajar', label: 'Absensi Pengajar' }]
        : [{ k: 'wb', label: 'Absensi Wajib Belajar' }, { k: 'takhassus', label: 'Absensi Takhassus' }]);

    const today = getTodayWib();
    let sentMap = {};
    try { sentMap = JSON.parse(localStorage.getItem(REMINDER_SENT_KEY) || '{}'); } catch (e) {}

    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const info = computeDeadlineCountdown(t.k);
      if (info.enabled && !info.passed && typeof info.diffMin === 'number' && info.diffMin >= 1 && info.diffMin <= 10) {
        const marker = `${today}_${t.k}`;
        if (!sentMap[marker]) {
          sentMap[marker] = true;
          try { localStorage.setItem(REMINDER_SENT_KEY, JSON.stringify(sentMap)); } catch (e) {}
          const msg = `Batas waktu ${t.label} pukul ${info.time} WIB (${info.diffMin} menit lagi). Segera selesaikan absensi.`;
          if (global.AndroidBridge && typeof global.AndroidBridge.notifyRealtimeEvent === 'function') {
            global.AndroidBridge.notifyRealtimeEvent(`Pengingat ${t.label}`, msg);
          } else if (typeof global.Swal !== 'undefined') {
            global.Swal.fire({ toast: true, position: 'top', icon: 'warning', title: msg, showConfirmButton: false, timer: 4500 });
          }
        }
        break;
      }
    }
  }

  function onSessionActivated() {
    lastBentoLoadedRoleKey = '';
    izinListCache = readLocalIzin();
    tindakanListCache = readLocalTindakan();
    // Sync deadlines ke Android native prefs untuk BackgroundSyncWorker
    try {
      if (global.AlRifaieAdminSettings && typeof global.AlRifaieAdminSettings.loadDeadlines === 'function' && global.AndroidBridge && typeof global.AndroidBridge.syncAttendanceDeadlines === 'function') {
        global.AndroidBridge.syncAttendanceDeadlines(JSON.stringify(global.AlRifaieAdminSettings.loadDeadlines()));
      }
    } catch (e) {}
    renderRoleBentoDashboard();
    if (!countdownIntervalId) {
      countdownIntervalId = setInterval(checkInAppDeadlineReminder, 30000);
    }
    setTimeout(checkInAppDeadlineReminder, 2000);
  }

  const WALI_SELECTED_CHILD_KEY = 'alrifaie_wali_selected_child_v1';
  let waliChildSearchQuery = '';

  function getSavedWaliChildName() {
    try {
      return String(localStorage.getItem(WALI_SELECTED_CHILD_KEY) || '').trim();
    } catch (e) {
      return '';
    }
  }

  function getSearchableWaliSantriDirectory() {
    const map = new Map();
    const base = getAllSantriDirectory();
    base.forEach(item => {
      const k = normText(item.nama);
      if (k) map.set(k, Object.assign({}, item));
    });
    const wbRows = (global.rekCache && global.rekCache.wb) || [];
    const tkRows = (global.rekCache && global.rekCache.takhassus) || [];
    wbRows.forEach(r => {
      const nm = String(r && r.nama || '').trim();
      const k = normText(nm);
      if (!k) return;
      if (!map.has(k)) map.set(k, { nama: nm, kamar: String(r.target || '').trim(), kelas: '' });
      else if (!map.get(k).kamar && r.target) map.get(k).kamar = String(r.target).trim();
    });
    tkRows.forEach(r => {
      const nm = String(r && r.nama || '').trim();
      const k = normText(nm);
      if (!k) return;
      if (!map.has(k)) map.set(k, { nama: nm, kamar: '', kelas: String(r.target || '').trim() });
      else if (!map.get(k).kelas && r.target) map.get(k).kelas = String(r.target).trim();
    });
    return Array.from(map.values()).sort((a, b) => a.nama.localeCompare(b.nama));
  }

  function onWaliChildSearchInput(rawVal) {
    waliChildSearchQuery = String(rawVal || '').trim();
    const box = document.getElementById('waliChildSearchResults');
    if (!box) return;
    const q = normText(waliChildSearchQuery);
    if (q.length < 2) {
      box.innerHTML = '';
      return;
    }
    const dir = getSearchableWaliSantriDirectory();
    const matches = dir.filter(s =>
      normText(s.nama).includes(q) ||
      normText(s.kamar).includes(q) ||
      normText(s.kelas).includes(q)
    ).slice(0, 12);

    if (!matches.length) {
      box.innerHTML = `<div class="p-3 rounded-xl bg-white/80 dark:bg-slate-900/70 border border-slate-200/70 dark:border-slate-700 text-xs text-slate-400 text-center">Santri dengan kata kunci "<b>${escHtml(waliChildSearchQuery)}</b>" tidak ditemukan.</div>`;
      return;
    }

    box.innerHTML = `<div class="max-h-56 overflow-y-auto space-y-1.5 pr-0.5">${matches.map(s => {
      const safeNama = escJsAttr(s.nama);
      const badges = [
        s.kamar ? `<span class="px-2 py-0.5 rounded-full text-[9.5px] font-bold bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300">Kamar ${escHtml(s.kamar)}</span>` : '',
        s.kelas ? `<span class="px-2 py-0.5 rounded-full text-[9.5px] font-bold bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300">${escHtml(s.kelas)}</span>` : ''
      ].filter(Boolean).join('');
      return `<button type="button" onclick="window.AlRifaieSmart.selectWaliChild('${safeNama}')" class="w-full p-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-700/80 hover:border-emerald-400 hover:bg-emerald-50/40 dark:hover:bg-emerald-950/30 flex items-center justify-between gap-2 text-left transition-all">
        <div class="min-w-0">
          <div class="text-xs font-extrabold text-slate-900 dark:text-white truncate">${escHtml(s.nama)}</div>
          <div class="flex flex-wrap gap-1 mt-1">${badges || '<span class="text-[10px] text-slate-400">Santri</span>'}</div>
        </div>
        <span class="px-2.5 py-1 rounded-lg bg-emerald-600 text-white text-[10px] font-bold shrink-0">Pilih</span>
      </button>`;
    }).join('')}</div>`;
  }

  function selectWaliChild(nama) {
    const clean = String(nama || '').trim();
    if (!clean) return;
    waliChildSearchQuery = '';
    try { localStorage.setItem(WALI_SELECTED_CHILD_KEY, clean); } catch (e) {}
    if (global.session && global.session.role === 'walisantri') {
      global.session.namaSantri = clean;
    }
    renderRoleBentoDashboard();
  }

  function clearWaliChildSelection() {
    waliChildSearchQuery = '';
    try { localStorage.removeItem(WALI_SELECTED_CHILD_KEY); } catch (e) {}
    if (global.session && global.session.role === 'walisantri') {
      global.session.namaSantri = '';
    }
    renderRoleBentoDashboard();
    setTimeout(() => {
      const inp = document.getElementById('waliChildSearchInput');
      if (inp) inp.focus();
    }, 60);
  }

  function openRekapForWaliChild(nama) {
    const clean = String(nama || '').trim();
    if (typeof global.switchTab === 'function') global.switchTab('rekap');
    setTimeout(() => {
      const inp = document.getElementById('rekSearchName');
      if (inp) {
        inp.value = clean;
        if (typeof global.filterRekapVisual === 'function') global.filterRekapVisual();
      }
    }, 220);
  }

  function onIzinTabOpened() {
    loadIzinDigital(true);
  }

  global.AlRifaieSmart = {
    openBottomSheet: openBottomSheet,
    closeBottomSheet: closeBottomSheet,
    isBottomSheetOpen: isBottomSheetOpen,
    loadIzinDigital: loadIzinDigital,
    renderIzinDigitalUI: renderIzinDigitalUI,
    renderIzinDeadlineBanner: renderIzinDeadlineBanner,
    updateIzinFormDeadlineNotice: updateIzinFormDeadlineNotice,
    setIzinFilter: setIzinFilter,
    openIzinFormSheet: openIzinFormSheet,
    autoFillIzinKamar: autoFillIzinKamar,
    submitIzinDigitalForm: submitIzinDigitalForm,
    approveOrRejectIzin: approveOrRejectIzin,
    deleteIzinItem: deleteIzinItem,
    getApprovedIzinForStaff: getApprovedIzinForStaff,
    getApprovedIzinForSantri: getApprovedIzinForSantri,
    switchSuratTarget: switchSuratTarget,
    switchSuratDocType: switchSuratDocType,
    applyHukumanPreset: applyHukumanPreset,
    renderSuratDisiplinPanel: renderSuratDisiplinPanel,
    toggleSuratPerson: toggleSuratPerson,
    toggleSelectAllSurat: toggleSelectAllSurat,
    openSuratDisiplinForPerson: openSuratDisiplinForPerson,
    generateSuratDisiplinPdf: generateSuratDisiplinPdf,
    downloadOfficialRekapPdf: downloadOfficialRekapPdf,
    startQuickScanForStaff: startQuickScanForStaff,
    openTindakanSheet: openTindakanSheet,
    saveTindakanForm: saveTindakanForm,
    openMissingMonitorSheet: openMissingMonitorSheet,
    refreshMissingMonitor: refreshMissingMonitor,
    syncMissingData: syncMissingData,
    renderRoleBentoDashboard: renderRoleBentoDashboard,
    onWaliChildSearchInput: onWaliChildSearchInput,
    selectWaliChild: selectWaliChild,
    clearWaliChildSelection: clearWaliChildSelection,
    openRekapForWaliChild: openRekapForWaliChild,
    onSessionActivated: onSessionActivated,
    onIzinTabOpened: onIzinTabOpened
  };

  // Sinkronisasi awal saat script selesai dimuat
  setTimeout(() => {
    izinListCache = readLocalIzin();
    tindakanListCache = readLocalTindakan();
    if (global.session && global.session.role) {
      onSessionActivated();
    }
  }, 450);
})(window);
