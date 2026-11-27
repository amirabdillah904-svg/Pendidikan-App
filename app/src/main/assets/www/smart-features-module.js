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

  function renderIzinDigitalUI() {
    const container = document.getElementById('izinDigitalList');
    const pendingBadge = document.getElementById('izinPendingCountBadge');
    const openBtn = document.getElementById('btnOpenIzinForm');
    const subEl = document.getElementById('izinTabSubtitle');
    const list = izinListCache.length ? izinListCache : readLocalIzin();
    izinListCache = list;

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

      const statusPill = isApproved
        ? '<span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 dark:bg-emerald-950/80 text-emerald-700 dark:text-emerald-300"><i class="fa-solid fa-check-circle mr-1"></i>Disetujui Admin</span>'
        : (isRejected
          ? '<span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-red-100 dark:bg-red-950/80 text-red-700 dark:text-red-300"><i class="fa-solid fa-circle-xmark mr-1"></i>Ditolak Admin</span>'
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
              <span class="text-[10px] text-slate-400">${it.diprosesOleh ? ('Diproses Admin: ' + escHtml(it.diprosesOleh)) : ''}</span>
              <button type="button" onclick="window.AlRifaieSmart.deleteIzinItem('${safeId}')" class="px-2.5 py-1 rounded-lg bg-red-50 dark:bg-red-950/50 text-red-600 dark:text-red-400 text-[10px] font-bold"><i class="fa-solid fa-trash mr-1"></i>Hapus</button>
            </div>`
          : (isOwnPending
            ? `<div class="flex items-center justify-between pt-2 mt-2 border-t border-slate-100 dark:border-slate-800">
                <span class="text-[10px] text-amber-600 dark:text-amber-400 font-semibold">Menunggu konfirmasi Admin</span>
                <button type="button" onclick="window.AlRifaieSmart.deleteIzinItem('${safeId}')" class="px-2.5 py-1 rounded-lg bg-red-50 dark:bg-red-950/50 text-red-600 dark:text-red-400 text-[10px] font-bold"><i class="fa-solid fa-xmark mr-1"></i>Batalkan</button>
              </div>`
            : (it.diprosesOleh ? `<div class="text-[10px] text-slate-400 pt-2 mt-2 border-t border-slate-100 dark:border-slate-800">Diproses oleh Admin: <b>${escHtml(it.diprosesOleh)}</b></div>` : '')));

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
          <input type="date" id="izStartDate" value="${today}" class="clean-input w-full px-3 py-2.5 text-xs font-semibold" required>
        </div>
        <div>
          <label class="block text-xs font-bold text-slate-700 dark:text-slate-200 mb-1">Sampai Tanggal</label>
          <input type="date" id="izEndDate" value="${today}" class="clean-input w-full px-3 py-2.5 text-xs font-semibold" required>
        </div>
      </div>
      <div>
        <label class="block text-xs font-bold text-slate-700 dark:text-slate-200 mb-1">Alasan / Keterangan (dan Badal jika ada)</label>
        <textarea id="izAlasan" rows="3" placeholder="Tuliskan alasan berhalangan hadir dan keterangan pengganti/badal bila ada..." class="clean-input w-full px-3.5 py-2.5 text-xs font-medium" required></textarea>
      </div>
      <p class="text-[10.5px] text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 p-2.5 rounded-xl">
        <i class="fa-solid fa-user-check mr-1"></i>${isAdmin ? 'Izin yang dicatat Admin langsung berstatus <b>Disetujui</b> &amp; otomatis tercatat di Absensi Musyrif/Pengajar.' : 'Pengajuan izin Anda akan dikirim ke <b>Admin</b> untuk disetujui. Setelah disetujui, status kehadiran Anda di Absensi Musyrif/Pengajar otomatis bertanda <b>Izin Digital</b>.'}
      </p>
      <div class="flex gap-2 pt-1">
        <button type="button" onclick="window.AlRifaieSmart.closeBottomSheet()" class="flex-1 py-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs font-bold">Batal</button>
        <button type="submit" class="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 text-white text-xs font-bold shadow-md">Kirim ke Admin</button>
      </div>
    </form>`;

    openBottomSheet('Ajukan Izin Musyrif / Pengajar', 'Persetujuan oleh Admin Departemen Pendidikan', bodyHtml, '');
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
    const initialStatus = isAdmin ? 'Disetujui' : 'Menunggu';
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
      diprosesOleh: isAdmin ? (sess.name || 'Admin') : '',
      catatanAdmin: '',
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
              const synced = readLocalIzin().map(x => x.id === id ? Object.assign({}, x, { id: res.id || id, status: res.status || initialStatus, localOnly: false }) : x);
              writeLocalIzin(synced);
              renderIzinDigitalUI();
            }
          })
          .withFailureHandler(() => {})
          .saveIzinDigital(record);
      }
    } catch (err) {}

    if (typeof global.Swal !== 'undefined') {
      global.Swal.fire('Pengajuan Terkirim', initialStatus === 'Disetujui'
        ? 'Izin langsung disetujui & otomatis terhubung ke absensi Musyrif/Pengajar.'
        : 'Pengajuan izin Anda berhasil dikirim dan menunggu persetujuan Admin.', 'success');
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
              global.rekCache[actType] = arr;
              resolve(arr);
            })
            .withFailureHandler(() => resolve([]))
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

  function buildOfficialKopHtml() {
    const appTitle = (global.appSettings && global.appSettings.appName) ? global.appSettings.appName : 'DEPARTEMEN PENDIDIKAN';
    const fallbackLogo = 'https://lh3.googleusercontent.com/d/1cVVxzS5pcO35NXDLh_W2YXUiSYuS3zg5';
    const rawLogo = String(document.querySelector('.logo-img')?.src || '').trim();
    const logoSrc = /^(https?:\/\/|data:image\/)/i.test(rawLogo) ? rawLogo : fallbackLogo;
    return `<div style="display:flex;align-items:center;gap:14px;border-bottom:3px double #0f172a;padding-bottom:10px;margin-bottom:16px;">
      <img src="${escHtml(logoSrc)}" crossorigin="anonymous" style="width:58px;height:58px;object-fit:contain;flex-shrink:0;">
      <div style="flex:1;text-align:center;">
        <div style="font-size:11px;font-weight:700;letter-spacing:1px;color:#065f46;text-transform:uppercase;">YAYASAN PENDIDIKAN MA'ARIF AL-RIFA'IE 2</div>
        <div style="font-size:16px;font-weight:900;letter-spacing:0.4px;color:#0f172a;text-transform:uppercase;margin-top:2px;">${escHtml(appTitle)}</div>
        <div style="font-size:10px;color:#475569;margin-top:2px;">Pondok Pesantren Modern Al-Rifa'ie 2 Gondanglegi — Malang, Jawa Timur</div>
      </div>
      <div style="width:58px;"></div>
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
    const todayIndo = formatIndoDate(getTodayWib());
    const kopHtml = buildOfficialKopHtml();

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

      const pagesHtml = selected.map((person, idx) => {
        const pageBreak = idx < selected.length - 1 ? 'page-break-after:always;break-after:page;' : '';
        const noSurat = `${String(idx + 1).padStart(2, '0')}/${isHukuman ? 'SH' : 'SP'}/DEPTPENDIK/${getTodayWib().slice(5, 7)}/${getTodayWib().slice(0, 4)}`;
        const rincianRows = person.alpaDates.slice(0, 12).map((d, i) => `<tr>
          <td style="border:1px solid #cbd5e1;padding:4px 8px;text-align:center;">${i + 1}</td>
          <td style="border:1px solid #cbd5e1;padding:4px 8px;">${escHtml(formatIndoDate(d.tanggal))}</td>
          <td style="border:1px solid #cbd5e1;padding:4px 8px;">${escHtml(d.sumber || (isMusyrif ? 'Absensi Musyrif' : 'Kegiatan Pendidikan'))}</td>
          <td style="border:1px solid #cbd5e1;padding:4px 8px;color:#b91c1c;font-weight:700;">Alpa (Tanpa Keterangan)</td>
        </tr>`).join('');

        const pelExtraHtml = person.pelList.length
          ? `<div style="margin-top:8px;font-size:11px;"><b>Catatan Pelanggaran / Keterlambatan:</b> ${escHtml(person.pelList.slice(0, 5).map(p => `${p.tanggal}: ${p.ket}`).join('; '))}</div>`
          : '';

        const bodyParagraphs = isHukuman
          ? `<p style="margin:10px 0;text-align:justify;">Berdasarkan data rekapitulasi kehadiran Departemen Pendidikan pada periode <b>${escHtml(periodText)}</b>, yang bersangkutan tercatat melakukan ketidakhadiran tanpa keterangan (<b>Alpa</b>) sebanyak <b>${person.alpaCount} kali</b>. Sebagai bentuk pembinaan kedisiplinan di lingkungan YPM Al-Rifa'ie 2, maka ditetapkan sanksi / hukuman (ta'zir) sebagai berikut:</p>
             <div style="border:1.5px solid #b91c1c;background:#fef2f2;padding:10px 14px;border-radius:8px;margin:10px 0;font-size:12px;font-weight:700;color:#7f1d1d;">${escHtml(hukumanText)}</div>
             <p style="margin:10px 0;text-align:justify;">Demikian surat hukuman / ta'zir ini diterbitkan untuk dilaksanakan dengan penuh tanggung jawab serta menjadi bahan evaluasi agar tidak mengulangi pelanggaran serupa di kemudian hari.</p>`
          : `<p style="margin:10px 0;text-align:justify;">Dengan ini saya menyatakan bahwa pada periode <b>${escHtml(periodText)}</b> saya benar telah melakukan ketidakhadiran tanpa keterangan (<b>Alpa</b>) sebanyak <b>${person.alpaCount} kali</b> sebagaimana rincian di bawah ini.</p>
             <p style="margin:10px 0;text-align:justify;">Saya menyadari sepenuhnya bahwa perbuatan tersebut melanggar tata tertib kedisiplinan <b>YPM Al-Rifa'ie 2</b>. Oleh karena itu, saya berjanji dengan sungguh-sungguh <b>tidak akan mengulangi ketidakhadiran tanpa izin (Alpa)</b> maupun pelanggaran disiplin lainnya di kemudian hari. Apabila di kemudian hari saya kembali melanggar pernyataan ini, saya bersedia menerima sanksi / ta'zir yang ditetapkan oleh Departemen Pendidikan.</p>`;

        const signerRightTitle = isMusyrif ? 'Musyrif yang Bersangkutan,' : 'Santri yang Bersangkutan,';
        const signerLeftTitle = isMusyrif ? 'Koordinator Musyrif,' : 'Mengetahui, Musyrif Kamar / Wali,';

        return `<div style="font-family:'Times New Roman',Georgia,serif;color:#0f172a;background:#ffffff;padding:18px 22px;font-size:12.5px;line-height:1.55;${pageBreak}">
          ${kopHtml}
          <div style="text-align:center;margin-bottom:14px;">
            <div style="font-size:15px;font-weight:900;text-decoration:underline;letter-spacing:0.6px;">${isHukuman ? 'SURAT KEPUTUSAN HUKUMAN (TA\'ZIR)' : 'SURAT PERNYATAAN KEDISIPLINAN'}</div>
            <div style="font-size:11px;color:#475569;margin-top:2px;">Nomor: ${escHtml(noSurat)}</div>
          </div>
          <p style="margin:8px 0;">Yang bertanda tangan / tercantum di bawah ini:</p>
          <table style="width:100%;border-collapse:collapse;margin:6px 0 12px 0;font-size:12.5px;">
            <tr><td style="width:155px;padding:3px 0;">Nama Lengkap</td><td style="width:12px;">:</td><td style="font-weight:700;">${escHtml(person.nama)}</td></tr>
            <tr><td style="padding:3px 0;">Status / Peran</td><td>:</td><td>${isMusyrif ? 'Musyrif Kamar' : 'Santri'}</td></tr>
            <tr><td style="padding:3px 0;">Kamar / Kelas</td><td>:</td><td>${escHtml(person.kamar)}</td></tr>
            <tr><td style="padding:3px 0;">Periode Rekap</td><td>:</td><td>${escHtml(periodText)} (${person.alpaCount}x Alpa)</td></tr>
          </table>
          ${bodyParagraphs}
          ${rincianRows ? `<div style="margin:12px 0;">
            <div style="font-size:11px;font-weight:700;margin-bottom:4px;">Rincian Catatan Ketidakhadiran (Alpa):</div>
            <table style="width:100%;border-collapse:collapse;font-size:11px;">
              <thead><tr style="background:#f1f5f9;">
                <th style="border:1px solid #cbd5e1;padding:4px 8px;width:32px;">No</th>
                <th style="border:1px solid #cbd5e1;padding:4px 8px;text-align:left;">Tanggal</th>
                <th style="border:1px solid #cbd5e1;padding:4px 8px;text-align:left;">Kegiatan</th>
                <th style="border:1px solid #cbd5e1;padding:4px 8px;text-align:left;">Status</th>
              </tr></thead>
              <tbody>${rincianRows}</tbody>
            </table>
            ${pelExtraHtml}
          </div>` : ''}
          <div style="text-align:right;margin-top:16px;font-size:12px;">Malang, ${escHtml(todayIndo)}</div>
          <table style="width:100%;margin-top:10px;font-size:12px;text-align:center;">
            <tr>
              <td style="width:50%;padding:4px;">${signerLeftTitle}<br><br><br><br><b>( _______________________ )</b></td>
              <td style="width:50%;padding:4px;">${signerRightTitle}<br><br><br><br><b>${escHtml(person.nama)}</b></td>
            </tr>
          </table>
          <div style="text-align:center;margin-top:18px;font-size:12px;">
            Mengetahui,<br><b>Ketua Departemen Pendidikan YPM Al-Rifa'ie 2</b><br><br><br><br>
            <b>( _____________________________ )</b>
          </div>
        </div>`;
      }).join('');

      const filename = `${isHukuman ? 'Surat_Hukuman' : 'Surat_Pernyataan'}_${isMusyrif ? 'Musyrif' : 'Santri'}_${getTodayWib()}.pdf`;
      await global.html2pdf().set({
        margin: 8,
        filename: filename,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, backgroundColor: '#ffffff', useCORS: true, scrollY: 0 },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: { mode: ['css', 'legacy'] }
      }).from(`<div>${pagesHtml}</div>`).save();

      if (typeof global.Swal !== 'undefined') global.Swal.close();
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
      <div class="p-3 rounded-xl bg-red-50/80 dark:bg-red-950/35 border border-red-200/70 dark:border-red-900/60 text-xs">
        <div class="font-bold text-red-700 dark:text-red-300"><i class="fa-solid fa-triangle-exclamation mr-1"></i>Catatan Masalah:</div>
        <div class="text-slate-700 dark:text-slate-200 mt-0.5">${escHtml(issueSummary || 'Memerlukan pembinaan kedisiplinan')}</div>
      </div>
      <div>
        <label class="block text-xs font-bold text-slate-700 dark:text-slate-200 mb-1">Jenis Tindakan yang Diambil</label>
        <select id="tndJenis" class="clean-input w-full px-3 py-2.5 text-xs font-semibold" required>
          <option value="Teguran Lisan & Nasihat">Teguran Lisan &amp; Nasihat</option>
          <option value="Pembinaan Personal di Kamar/Kelas">Pembinaan Personal di Kamar/Kelas</option>
          <option value="Koordinasi dengan Wali Santri">Koordinasi dengan Wali Santri</option>
          <option value="Pembuatan Surat Pernyataan">Pembuatan Surat Pernyataan</option>
          <option value="Dilaporkan ke Departemen Pendidikan">Dilaporkan ke Departemen Pendidikan</option>
        </select>
      </div>
      <div>
        <label class="block text-xs font-bold text-slate-700 dark:text-slate-200 mb-1">Catatan Hasil Pembinaan (Opsional)</label>
        <textarea id="tndCatatan" rows="2" placeholder="Cth: Santri mengakui kesalahan dan berjanji hadir tepat waktu..." class="clean-input w-full px-3 py-2 text-xs"></textarea>
      </div>
      <div class="flex gap-2 pt-1">
        <button type="button" onclick="window.AlRifaieSmart.closeBottomSheet(); window.AlRifaieSmart.openSuratDisiplinForPerson('santri','${safeNama}')" class="px-3 py-2.5 rounded-xl bg-red-50 dark:bg-red-950/60 text-red-700 dark:text-red-300 text-xs font-bold inline-flex items-center gap-1"><i class="fa-solid fa-file-signature"></i><span>Buat Surat</span></button>
        <button type="submit" class="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-indigo-600 to-emerald-600 text-white text-xs font-bold shadow-md">Simpan Tindakan</button>
      </div>
      ${historyHtml}
    </form>`;

    openBottomSheet('Tindak Lanjut Santri', `${namaSantri} • ${kamarKelas}`, bodyHtml, '');
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

  function openMissingMonitorSheet() {
    const data = cachedMissingToday || { wb: [], takhassus: [] };
    const wbList = data.wb || [];
    const tkList = data.takhassus || [];
    const bodyHtml = `<div class="space-y-3">
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

  function refreshMissingMonitor(reopenSheet) {
    const tgl = getTodayWib();
    const ym = tgl.slice(0, 7);
    if (global.google && global.google.script && global.google.script.run && typeof global.google.script.run.getMissingAttendance === 'function') {
      global.google.script.run
        .withSuccessHandler(res => {
          if (res && typeof res === 'object') {
            cachedMissingToday = { wb: res.wb || [], takhassus: res.takhassus || [] };
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

    // ===== 1. BERANDA WALI SANTRI =====
    if (role === 'walisantri') {
      const childRaw = String(sess.namaSantri || '').trim();
      const childNorm = normText(childRaw);
      const dir = getAllSantriDirectory();
      const matchedChild = childNorm
        ? dir.find(s => normText(s.nama) === childNorm || childNorm.includes(normText(s.nama)) || normText(s.nama).includes(childNorm))
        : null;
      const displayChildName = matchedChild ? matchedChild.nama : (childRaw || 'Putra / Putri Anda');
      const childMeta = matchedChild ? [matchedChild.kamar ? ('Kamar ' + matchedChild.kamar) : '', matchedChild.kelas].filter(Boolean).join(' • ') : 'Terhubung ke akun Wali Santri';

      const wbRows = (global.rekCache && global.rekCache.wb) || [];
      const tkRows = (global.rekCache && global.rekCache.takhassus) || [];
      const allChildRecs = wbRows.concat(tkRows).filter(r => {
        const rn = normText(r.nama);
        const target = normText(displayChildName);
        if (!target || !rn) return false;
        return (rn === target || rn.includes(target) || target.includes(rn)) && String(r.tanggal || '').startsWith(todayYm);
      });

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

      root.innerHTML = `<div class="space-y-3">
        <div class="bento-card p-4 border-l-4 border-l-emerald-600 space-y-3.5">
          <div class="flex items-start justify-between gap-3">
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
        </div>
      </div>`;
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

      let alertHtml = '';
      if (!hasLockedAssignment) {
        alertHtml = `<div class="bento-card p-3.5 flex items-center gap-3 border border-amber-200/80 dark:border-amber-900/60 bg-amber-50/60 dark:bg-amber-950/25">
          <div class="w-9 h-9 rounded-xl bg-amber-500 text-white flex items-center justify-center shrink-0"><i class="fa-solid fa-lock text-sm"></i></div>
          <div class="min-w-0">
            <div class="text-xs font-bold text-amber-800 dark:text-amber-300">${role === 'musyrif' ? 'Kamar Binaan' : 'Kelas Binaan'} Belum Tertaut</div>
            <div class="text-[11px] text-slate-500">Daftar santri bermasalah terkunci otomatis per ${role === 'musyrif' ? 'kamar' : 'kelas'}. Hubungi Admin jika belum muncul.</div>
          </div>
        </div>`;
      } else if (problematicList.length) {
        alertHtml = `<div class="bento-card p-4 border-l-4 border-l-red-500 bg-gradient-to-br from-red-50/75 via-white to-amber-50/40 dark:from-red-950/35 dark:via-slate-900 dark:to-amber-950/20 space-y-3">
          <div class="flex items-start justify-between gap-2 flex-wrap">
            <div class="flex items-center gap-2.5 min-w-0">
              <div class="w-10 h-10 rounded-2xl bg-red-600 text-white flex items-center justify-center shrink-0 shadow-sm">
                <i class="fa-solid fa-bell text-sm"></i>
              </div>
              <div class="min-w-0">
                <h3 class="text-xs sm:text-sm font-extrabold text-red-700 dark:text-red-300">Informasi Santri Bermasalah (${problematicList.length})</h3>
                <p class="text-[11px] text-slate-600 dark:text-slate-300">Hanya menampilkan santri di binaan Anda &bull; Pembuatan surat dikelola oleh Admin</p>
              </div>
            </div>
            <span class="px-2.5 py-1 rounded-full text-[10px] font-bold bg-indigo-50 dark:bg-indigo-950/70 text-indigo-700 dark:text-indigo-300 border border-indigo-200/70 dark:border-indigo-800/60 inline-flex items-center gap-1 shrink-0">
              <i class="fa-solid fa-lock text-[9px]"></i>
              <span>Terkunci: ${escHtml(assign.label)}</span>
            </span>
          </div>
          <div class="space-y-2 max-h-64 overflow-y-auto pr-0.5">
            ${problematicList.map(p => {
              const latestDates = p.alpaDates.slice(-3).reverse().join(', ');
              return `<div class="p-3 rounded-2xl bg-white/95 dark:bg-slate-900/80 border border-red-200/70 dark:border-red-900/50 space-y-1">
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

    // ===== 3. BERANDA ADMIN & PENGURUS (SOFT BENTO OPERATIONAL KPI) =====
    if (role === 'admin' || role === 'user') {
      const isAdmin = role === 'admin';
      const missingWb = cachedMissingToday ? (cachedMissingToday.wb || []).length : null;
      const missingTk = cachedMissingToday ? (cachedMissingToday.takhassus || []).length : null;
      const totalMissing = missingWb !== null ? (missingWb + missingTk) : '...';
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
              <span class="w-9 h-9 rounded-xl bg-red-50 dark:bg-red-950/60 text-red-600 dark:text-red-400 flex items-center justify-center text-sm"><i class="fa-solid fa-clock-rotate-left"></i></span>
              <span class="text-[10px] font-bold text-slate-400">Hari Ini</span>
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

  function onIzinTabOpened() {
    loadIzinDigital(true);
  }

  global.AlRifaieSmart = {
    openBottomSheet: openBottomSheet,
    closeBottomSheet: closeBottomSheet,
    isBottomSheetOpen: isBottomSheetOpen,
    loadIzinDigital: loadIzinDigital,
    renderIzinDigitalUI: renderIzinDigitalUI,
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
    renderRoleBentoDashboard: renderRoleBentoDashboard,
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
