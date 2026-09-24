/**
     * ============================================================
     * PORTAL EDUMEDIA — Frontend JavaScript
     * Arsitektur: GAS-PRO-API — frontend statis (GitHub Pages) + GAS
     * sebagai REST API murni (fetch, bukan google.script.run/iframe).
     * Lapisan transport ada di js/api.js — semua pemanggilan di file
     * ini tetap ditulis gaya google.script.run.xxx(...) apa adanya.
     * Prinsip: SPA murni (navigasi 0ms), cache lokal (AppState.cache),
     * optimistic UI pada aksi ringan.
     * ============================================================
     */
    
    // ════════════════════════════════════════════════════════
    // BAGIAN 1: STATE APLIKASI (di memori, BUKAN di URL)
    // ════════════════════════════════════════════════════════
    
    /**
     * Cache persisten: sama seperti objek biasa (AppState.cache.xxx = ...,
     * delete AppState.cache.xxx, bahkan AppState.cache.kelasDetail[id] = ...),
     * TAPI setiap perubahan (termasuk yang bersarang) otomatis ikut disimpan
     * ke localStorage lewat Proxy — tidak ada satu pun titik pemanggilan cache
     * di bawah yang perlu diubah.
     *
     * Manfaatnya: navigasi PERTAMA KALI ke sebuah menu pun bisa langsung
     * instan selama pernah dibuka di browser ini sebelumnya (data lama
     * langsung tampil, lalu disegarkan diam-diam di background) — tidak lagi
     * harus menunggu dulu satu kali "pemanasan" di setiap sesi baru.
     */
    const CACHE_STORAGE_KEY = 'em_cache_v1';
    function createPersistentCache() {
      let store = {};
      try {
        const raw = localStorage.getItem(CACHE_STORAGE_KEY);
        if (raw) store = JSON.parse(raw);
      } catch (e) { store = {}; }
    
      function persist() {
        try { localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(store)); }
        catch (e) { /* localStorage penuh/nonaktif — cache tetap jalan di memori saja */ }
      }
    
      function wrap(target) {
        return new Proxy(target, {
          get(t, prop) {
            const val = t[prop];
            return (val && typeof val === 'object') ? wrap(val) : val;
          },
          set(t, prop, value) { t[prop] = value; persist(); return true; },
          deleteProperty(t, prop) { delete t[prop]; persist(); return true; }
        });
      }
      return wrap(store);
    }
    // Dipanggil saat logout / sesi habis — cache lama dihapus total (privasi,
    // supaya pengguna berikutnya di komputer yang sama tidak melihat data
    // pengguna sebelumnya), lalu cache baru yang kosong disiapkan lagi.
    function clearPersistentCache() {
      try { localStorage.removeItem(CACHE_STORAGE_KEY); } catch (e) {}
      AppState.cache = createPersistentCache();
    }
    
    const AppState = {
      sessionToken: null,
      role: null, nama: null, id: null, email: null,
      currentSection: null,
      cache: createPersistentCache(),  // cache hasil fetch per section, bertahan lintas refresh (localStorage)
      guestData: null,
      chartInstances: {},
      baseUrl: window.location.href.split('?')[0]  // URL frontend sendiri (GitHub Pages), stabil & selalu benar
    };
    
    const SECTION_TITLES = {
      katalogSaya: 'Katalog Saya', manajemenKelas: 'Manajemen Kelas', laporanAktivitas: 'Laporan Aktivitas',
      tutorialTeks: 'Tutorial Penggunaan', redeemKode: 'Redeem Kode Video Tutorial', videoTutorialSaya: 'Video Tutorial Saya',
      adminDashboard: 'Admin Dashboard', manajemenUser: 'Manajemen User & Akses Silang',
      bankVideoTutorial: 'Bank Video Tutorial', kelolaKontenTutorial: 'Kelola Konten Tutorial', laporanGlobal: 'Laporan Aktivitas Global',
      monitoringKatalogKelas: 'Monitoring Katalog & Kelas'
    };
    
    // ════════════════════════════════════════════════════════
    // BAGIAN 2: INISIALISASI
    // ════════════════════════════════════════════════════════
    
    document.addEventListener('DOMContentLoaded', () => {
      const savedTheme = localStorage.getItem('em_theme') || 'light';
      document.documentElement.setAttribute('data-theme', savedTheme);
      updateDarkModeIcon(savedTheme);
    
      // Frontend kini di-hosting sendiri (GitHub Pages) — window.location.search
      // selalu bisa diandalkan untuk membaca parameter URL (?token=...), berbeda
      // dari versi GAS HtmlService lama yang dirender di iframe sandbox terpisah.
      const guestToken = new URLSearchParams(window.location.search).get('token');
    
      if (guestToken) {
        initGuestMode(guestToken);
      } else {
        // Pulihkan sesi Dosen/Admin setelah refresh browser, dari token yang
        // disimpan di sessionStorage (bukan di URL).
        const savedToken = sessionStorage.getItem('em_token');
        if (savedToken) {
          google.script.run
            .withSuccessHandler(res => {
              hideLoadingOverlay();
              if (res.success) { restoreSession(res.data); } else { sessionStorage.removeItem('em_token'); sessionStorage.removeItem('em_last_section'); showView('login'); }
            })
            .withFailureHandler(() => { hideLoadingOverlay(); showView('login'); })
            .checkSession(savedToken);
        } else {
          hideLoadingOverlay();
          showView('login');
        }
      }
    });
    
    function restoreSession(data) {
      AppState.sessionToken = data.token; AppState.role = data.role; AppState.nama = data.nama; AppState.id = data.id; AppState.email = data.email;
      applyUserChip();
      document.getElementById('navGroupAdmin').style.display = AppState.role === 'Admin' ? 'block' : 'none';
      document.getElementById('navGroupDosen').style.display = AppState.role === 'Admin' ? 'none' : 'block';
      showView('app');
      const lastSection = sessionStorage.getItem('em_last_section');
      navigateTo(lastSection && SECTION_TITLES[lastSection] ? lastSection : data.landingPage);
      prefetchAfterLogin(AppState.role);
    }
    
    // Menu mana saja yang "dipanaskan" diam-diam di background setelah login,
    // per role — supaya saat pengguna benar-benar mengklik menu tsb, cache-nya
    // sudah terisi dan tampil instan, bukan baru mulai fetch saat itu juga.
    const PREFETCH_MAP = {
      Dosen: [
        { cacheKeys: ['katalogSaya'], action: 'getKatalogSaya' },
        { cacheKeys: ['kelasSaya'], action: 'getKelasSaya' },
        { cacheKeys: ['videoTutorialSaya'], action: 'getSemuaVideoUntukDosen' },
        { cacheKeys: ['tutorialTeks', 'kelolaKonten'], action: 'getTutorialKonten' }
      ],
      Admin: [
        { cacheKeys: ['adminDashboard'], action: 'getAdminDashboardData' },
        { cacheKeys: ['bankVideo'], action: 'getBankVideo' },
        { cacheKeys: ['users'], action: 'getAllUsers' },
        { cacheKeys: ['kelolaKonten', 'tutorialTeks'], action: 'getTutorialKonten' }
      ]
    };
    
    function prefetchAfterLogin(role) {
      (PREFETCH_MAP[role] || []).forEach((item, i) => {
        // Ditunda bertahap (staggered) supaya tidak membanjiri server dengan
        // banyak request bersamaan tepat setelah login. Ini murni pemanasan
        // cache di belakang layar — tidak menyentuh DOM, tidak menampilkan
        // skeleton/toast apa pun, dan kalau gagal cukup dibiarkan (nanti
        // menu terkait tetap fetch normal seperti biasa saat benar-benar dibuka).
        setTimeout(() => {
          google.script.run
            .withSuccessHandler(res => { if (res.success) item.cacheKeys.forEach(key => { AppState.cache[key] = res.data; }); })
            .withFailureHandler(() => {})
            [item.action](AppState.sessionToken);
        }, i * 350);
      });
    }
    
    function hideLoadingOverlay() {
      const el = document.getElementById('loadingOverlay');
      if (el) { el.style.opacity = '0'; setTimeout(() => el.style.display = 'none', 250); }
    }
    
    function showView(view) {
      ['view-login', 'view-guest', 'view-guest-invalid', 'app-shell'].forEach(id => {
        document.getElementById(id).style.display = 'none';
      });
      const map = { login: 'view-login', guest: 'view-guest', guestInvalid: 'view-guest-invalid', app: 'app-shell' };
      const target = document.getElementById(map[view]);
      target.style.display = view === 'app' ? 'block' : (view === 'guest' || view === 'login' || view === 'guestInvalid') ? 'flex' : 'block';
      if (view === 'app') target.style.display = 'block';
    }
    
    // ════════════════════════════════════════════════════════
    // BAGIAN 3: MODE TAMU (MAHASISWA) — tanpa login
    // ════════════════════════════════════════════════════════
    
    function initGuestMode(token) {
      google.script.run
        .withSuccessHandler(res => {
          hideLoadingOverlay();
          if (!res.success) { showView('guestInvalid'); return; }
          AppState.guestData = res.data;
          AppState.guestData.token = token;
          renderGuestCatalog(res.data);
          showView('guest');
        })
        .withFailureHandler(err => { hideLoadingOverlay(); showView('guestInvalid'); })
        .getGuestCatalog(token);
    }
    
    function renderGuestCatalog(data) {
      const CAT_COLORS = { 'Simulasi': 'badge-info', 'Slide Interaktif': 'badge-lecturer', 'Live Coding': 'badge-warning', 'Kuis': 'badge-danger', 'Papan Kolaborasi': 'badge-success' };
      const cardsHtml = data.links.length ? data.links.map(l => `
        <div class="media-card">
          <div class="media-thumb">
            ${l.thumbnail ? `<img src="${escapeHtml(l.thumbnail)}" alt="">` : `<div class="play-overlay"><i class="bi bi-image"></i></div>`}
            <span class="media-cat-badge">${escapeHtml(l.kategori || 'Umum')}</span>
          </div>
          <div class="media-body">
            <div class="media-title">${escapeHtml(l.judul)}</div>
            <div class="media-desc">${escapeHtml(l.deskripsi || '')}</div>
            <button class="btn btn-accent w-100" onclick="openGuestLink('${l.id}', '${encodeURIComponent(l.tautan)}')">
              Buka Materi <i class="bi bi-box-arrow-up-right"></i>
            </button>
          </div>
        </div>
      `).join('') : `<div class="empty-state" style="width:100%;"><i class="bi bi-inbox"></i><p class="mt-2">Belum ada materi dibagikan untuk kelas ini.</p></div>`;
    
      document.getElementById('guestContent').innerHTML = `
        <div class="guest-header">
          <div class="guest-header-inner">
            <span class="badge-status badge-warning mb-2 d-inline-block"><i class="bi bi-person-check"></i> Mode Tamu Mahasiswa</span>
            <h3 class="fw-jakarta fw-bold mb-1">${escapeHtml(data.namaKelas)}</h3>
            <p class="mb-0 opacity-75">Dosen Pengampu: ${escapeHtml(data.namaDosen)} &nbsp;•&nbsp; Akses langsung tanpa perlu login</p>
          </div>
        </div>
        <div class="guest-grid">${cardsHtml}</div>
        <div class="text-center text-muted small pb-4">Portal EduMedia • Aktivitas klik tercatat otomatis ke log rombel</div>
      `;
    }
    
    function openGuestLink(idLink, encodedUrl) {
      const url = decodeURIComponent(encodedUrl);
      window.open(url, '_blank'); // tab baru — bukan navigasi iframe, jadi aman
      google.script.run.recordLinkClick(idLink, AppState.guestData.token); // fire & forget
    }
    
    // ════════════════════════════════════════════════════════
    // BAGIAN 4: LOGIN / LOGOUT DOSEN & ADMIN
    // ════════════════════════════════════════════════════════
    
    function handleLogin(event) {
      event.preventDefault();
      const identifier = document.getElementById('loginIdentifier').value.trim();
      const password = document.getElementById('loginPassword').value;
      const btn = event.target.querySelector('button[type="submit"]');
      const original = btn.innerHTML;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Memproses...';
      btn.disabled = true;
    
      google.script.run
        .withSuccessHandler(res => { btn.innerHTML = original; btn.disabled = false; handleLoginResult(res); })
        .withFailureHandler(err => { btn.innerHTML = original; btn.disabled = false; showToast('Error', err.message, 'danger'); })
        .doLogin(identifier, password);
    }
    
    // CATATAN MIGRASI: sejak frontend pindah ke origin terpisah (GitHub Pages)
    // dan berkomunikasi via fetch() murni, Session.getActiveUser() di backend
    // kemungkinan besar TIDAK bisa lagi mendeteksi akun Google pengguna (fetch
    // lintas origin tidak membawa konteks sesi Google seperti google.script.run
    // di dalam iframe GAS dulu). Tombol ini akan gagal dengan pesan yang sudah
    // ditangani ("Tidak dapat membaca akun Google...") — bukan error fatal,
    // tapi login utama yang disarankan pasca-migrasi adalah NIDN/Email + kata sandi.
    function handleGoogleLogin() {
      google.script.run
        .withSuccessHandler(handleLoginResult)
        .withFailureHandler(err => showToast('Error', err.message, 'danger'))
        .loginWithGoogle();
    }
    
    function handleLoginResult(res) {
      if (!res.success) { showToast('Gagal Masuk', res.message, 'danger'); return; }
      AppState.sessionToken = res.data.token;
      AppState.role = res.data.role; AppState.nama = res.data.nama; AppState.id = res.data.id; AppState.email = res.data.email;
      sessionStorage.setItem('em_token', res.data.token); // FIX: bertahan saat refresh, tidak pernah masuk ke URL
      applyUserChip();
      document.getElementById('navGroupAdmin').style.display = AppState.role === 'Admin' ? 'block' : 'none';
      document.getElementById('navGroupDosen').style.display = AppState.role === 'Admin' ? 'none' : 'block';
      showView('app');
      showToast('Selamat Datang', `Halo, ${res.data.nama}!`, 'success');
      navigateTo(res.data.landingPage);
      prefetchAfterLogin(AppState.role);
    }
    
    function applyUserChip() {
      const initials = (AppState.nama || 'US').split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
      document.getElementById('sidebarAvatar').textContent = initials;
      document.getElementById('sidebarNama').textContent = AppState.nama;
      document.getElementById('sidebarRole').textContent = AppState.role === 'Admin' ? 'Administrator' : 'Dosen Pengampu';
    }
    
    function handleLogout() {
      google.script.run.doLogout(AppState.sessionToken); // fire & forget
      AppState.sessionToken = null; AppState.role = null; clearPersistentCache();
      sessionStorage.removeItem('em_token'); sessionStorage.removeItem('em_last_section');
      document.getElementById('loginForm').reset();
      showView('login');
    }
    
    // Jika sesi berakhir di tengah pemakaian
    function handleSessionExpired() {
      showToast('Sesi Berakhir', 'Silakan login kembali.', 'warning');
      AppState.sessionToken = null; clearPersistentCache();
      sessionStorage.removeItem('em_token'); sessionStorage.removeItem('em_last_section');
      showView('login');
    }
    
    // ════════════════════════════════════════════════════════
    // BAGIAN 5: ROUTER SPA — INSTANT (0ms, tanpa reload / URL)
    // ════════════════════════════════════════════════════════
    
    function navigateTo(section) {
      document.querySelectorAll('.content-section').forEach(s => s.classList.remove('active'));
      document.getElementById('section-' + section).classList.add('active');
      document.querySelectorAll('.sidebar-nav .nav-link').forEach(l => l.classList.toggle('active', l.dataset.section === section));
      document.getElementById('pageTitle').textContent = SECTION_TITLES[section] || 'Halaman';
      AppState.currentSection = section;
      sessionStorage.setItem('em_last_section', section); // FIX: dipulihkan setelah refresh
      closeSidebarMobile();
    
      const loaders = {
        katalogSaya: loadKatalogSaya, manajemenKelas: loadManajemenKelas, laporanAktivitas: loadLaporanAktivitas,
        tutorialTeks: loadTutorialTeks, redeemKode: loadRedeemKode, videoTutorialSaya: loadVideoTutorialSaya,
        adminDashboard: loadAdminDashboard, manajemenUser: loadManajemenUser, bankVideoTutorial: loadBankVideoTutorial,
        kelolaKontenTutorial: loadKelolaKontenTutorial, laporanGlobal: loadLaporanGlobal,
        monitoringKatalogKelas: loadMonitoringKatalogKelas
      };
      if (loaders[section]) loaders[section]();
    }
    
    function toggleSidebar() {
      document.getElementById('sidebar').classList.toggle('show');
      document.getElementById('sidebarOverlay').classList.toggle('show');
    }
    function closeSidebarMobile() {
      document.getElementById('sidebar').classList.remove('show');
      document.getElementById('sidebarOverlay').classList.remove('show');
    }
    
    function toggleDarkMode() {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('em_theme', next);
      updateDarkModeIcon(next);
      Object.values(AppState.chartInstances).forEach(c => c && c.update());
    }
    function updateDarkModeIcon(theme) {
      const icon = document.getElementById('darkModeIcon');
      if (icon) icon.className = theme === 'dark' ? 'bi bi-sun' : 'bi bi-moon-stars';
    }
    
    // ════════════════════════════════════════════════════════
    // BAGIAN 6: UTILITAS UI (toast, skeleton, escape)
    // ════════════════════════════════════════════════════════
    
    function showToast(title, message, type) {
      type = type || 'info';
      const icons = { success: 'bi-check-circle-fill text-success', danger: 'bi-x-circle-fill text-danger', warning: 'bi-exclamation-triangle-fill text-warning', info: 'bi-info-circle-fill' };
      document.getElementById('toastTitle').textContent = title;
      document.getElementById('toastBody').textContent = message;
      document.getElementById('toastIcon').className = 'bi ' + (icons[type] || icons.info) + ' me-2';
      new bootstrap.Toast(document.getElementById('appToast'), { delay: 3800 }).show();
    }
    
    function escapeHtml(str) {
      if (str === null || str === undefined) return '';
      return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    
    function skeletonBlock(container, rows) {
      rows = rows || 3;
      let html = '<div class="d-flex flex-column gap-2 py-2">';
      for (let i = 0; i < rows; i++) html += `<div class="skeleton" style="height:52px;"></div>`;
      html += '</div>';
      document.getElementById(container).innerHTML = html;
    }
    
    function handleBackendError(err) {
      if (err && err.message === 'SESSION_EXPIRED') { handleSessionExpired(); return; }
      showToast('Error', (err && err.message) || 'Terjadi kesalahan.', 'danger');
    }
    
    // ════════════════════════════════════════════════════════
    // BAGIAN 7: KATALOG SAYA (Dosen) — CRUD tautan media
    // ════════════════════════════════════════════════════════
    
    function loadKatalogSaya() {
      const el = document.getElementById('section-katalogSaya');
      el.innerHTML = pageHeaderHtml('Katalog Media Dosen', 'Katalog Saya', 'Kelola tautan media interaktif untuk didistribusikan ke kelas Anda.',
        `<button class="btn btn-accent" onclick="openLinkForm()"><i class="bi bi-plus-lg"></i> Tambah Link Media</button>`)
        + `<div id="katalogSayaBody"></div>`;
      const cached = AppState.cache.katalogSaya;
      if (cached) { renderKatalogSaya(cached); } else { skeletonBlock('katalogSayaBody', 4); }
    
      google.script.run
        .withSuccessHandler(res => {
          if (!res.success) { if (!cached) handleBackendError(res); return; }
          AppState.cache.katalogSaya = res.data;
          renderKatalogSaya(res.data);
        })
        .withFailureHandler(err => { if (!cached) handleBackendError(err); })
        .getKatalogSaya(AppState.sessionToken);
    }
    
    function renderKatalogSaya(links) {
      const container = document.getElementById('katalogSayaBody');
      const aktif = links.filter(l => l.status === 'Aktif').length;
    
      const statRow = `
        <div class="row g-3 mb-3">
          <div class="col-6 col-md-3"><div class="stat-card"><div class="stat-value">${links.length}</div><div class="stat-label">Total Media</div></div></div>
          <div class="col-6 col-md-3"><div class="stat-card"><div class="stat-value">${aktif}</div><div class="stat-label">Status Aktif</div></div></div>
        </div>`;
    
      if (!links.length) {
        container.innerHTML = statRow + `<div class="empty-state"><i class="bi bi-collection"></i><p class="mt-2">Belum ada materi. Klik "Tambah Link Media" untuk mulai.</p></div>`;
        return;
      }
    
      const rows = links.map(l => `
        <tr>
          <td><img class="table-thumb" src="${escapeHtml(l.thumbnail)}" alt=""></td>
          <td>
            <div class="fw-semibold">${escapeHtml(l.judul)}</div>
            <div class="text-secondary small">${escapeHtml((l.deskripsi || '').substring(0, 60))}${(l.deskripsi || '').length > 60 ? '…' : ''}</div>
            ${!l.isMilikSendiri ? `<span class="badge-status badge-lecturer mt-1 d-inline-block">Milik ${escapeHtml(l.namaPemilik)}</span>` : ''}
          </td>
          <td class="text-secondary small">${escapeHtml(l.kategori || 'Umum')}</td>
          <td class="text-secondary small">${l.kelasTerhubung.length ? l.kelasTerhubung.map(k => escapeHtml(k)).join(', ') : '<span class="text-muted">Belum ada kelas</span>'}</td>
          <td><span class="badge-status ${l.status === 'Aktif' ? 'badge-success' : 'badge-warning'}">${l.status}</span></td>
          <td class="text-end">
            <a href="${escapeHtml(l.tautan)}" target="_blank" rel="noopener" class="btn btn-sm btn-outline-navy me-1" title="Buka media di tab baru"><i class="bi bi-box-arrow-up-right"></i></a>
            ${l.isMilikSendiri ? `
            <button class="btn btn-sm btn-outline-navy me-1" onclick='openLinkForm(${JSON.stringify(l).replace(/'/g, "&apos;")})'><i class="bi bi-pencil"></i></button>
            <button class="btn btn-sm btn-outline-secondary" onclick="confirmDeleteLink('${l.id}', '${escapeHtml(l.judul).replace(/'/g, "\\'")}')"><i class="bi bi-trash text-danger"></i></button>
            ` : ''}
          </td>
        </tr>
      `).join('');
    
      container.innerHTML = statRow + `
        <div class="table-wrap">
          <div class="table-responsive">
            <table class="app-table">
              <thead><tr><th></th><th>Judul Materi</th><th>Kategori</th><th>Kelas Terhubung</th><th>Status</th><th class="text-end">Aksi</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>`;
    }
    
    function openLinkForm(data) {
      document.getElementById('formLink').reset();
      document.getElementById('thumbPreviewBox').style.display = 'none';
      if (data && data.id) {
        document.getElementById('modalLinkFormTitle').innerHTML = '<i class="bi bi-pencil"></i> Edit Tautan Media Pembelajaran';
        document.getElementById('linkId').value = data.id;
        document.getElementById('linkJudul').value = data.judul;
        document.getElementById('linkKategori').value = data.kategori || 'Umum';
        document.getElementById('linkDeskripsi').value = data.deskripsi || '';
        document.getElementById('linkTautan').value = data.tautan;
        document.getElementById('linkThumbnail').value = data.thumbnail;
        document.getElementById('linkStatusAktif').checked = data.status === 'Aktif';
        previewThumbnail();
      } else {
        document.getElementById('modalLinkFormTitle').innerHTML = '<i class="bi bi-link-45deg"></i> Tambah Tautan Media Pembelajaran';
        document.getElementById('linkId').value = '';
      }
      new bootstrap.Modal(document.getElementById('modalLinkForm')).show();
    }
    
    function previewThumbnail() {
      const url = document.getElementById('linkThumbnail').value;
      const box = document.getElementById('thumbPreviewBox');
      if (url) { document.getElementById('thumbPreviewImg').src = url; box.style.display = 'block'; } else { box.style.display = 'none'; }
    }
    
    function submitLinkForm(event) {
      event.preventDefault();
      const btn = document.getElementById('btnSaveLinkForm');
      const original = btn.innerHTML;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Menyimpan...';
      btn.disabled = true;
    
      const record = {
        id: document.getElementById('linkId').value || null,
        judul: document.getElementById('linkJudul').value.trim(),
        kategori: document.getElementById('linkKategori').value,
        deskripsi: document.getElementById('linkDeskripsi').value.trim(),
        tautan: document.getElementById('linkTautan').value.trim(),
        thumbnail: document.getElementById('linkThumbnail').value.trim(),
        status: document.getElementById('linkStatusAktif').checked ? 'Aktif' : 'Nonaktif'
      };
    
      google.script.run
        .withSuccessHandler(res => {
          btn.innerHTML = original; btn.disabled = false;
          if (!res.success) return handleBackendError(res);
          bootstrap.Modal.getInstance(document.getElementById('modalLinkForm')).hide();
          showToast('Berhasil', res.message, 'success');
          loadKatalogSaya();
        })
        .withFailureHandler(err => { btn.innerHTML = original; btn.disabled = false; handleBackendError(err); })
        .saveKatalogLink(AppState.sessionToken, record);
    }
    
    function confirmDeleteLink(id, judul) {
      document.getElementById('modalConfirmText').textContent = `Hapus materi "${judul}"? Tindakan ini tidak dapat dibatalkan.`;
      const btn = document.getElementById('btnModalConfirmAction');
      btn.onclick = () => {
        google.script.run
          .withSuccessHandler(res => {
            bootstrap.Modal.getInstance(document.getElementById('modalConfirm')).hide();
            if (!res.success) return handleBackendError(res);
            showToast('Berhasil', res.message, 'success');
            loadKatalogSaya();
          })
          .withFailureHandler(handleBackendError)
          .deleteKatalogLink(AppState.sessionToken, id);
      };
      new bootstrap.Modal(document.getElementById('modalConfirm')).show();
    }
    
    // ════════════════════════════════════════════════════════
    // BAGIAN 8: MANAJEMEN KELAS & DISTRIBUSI TAUTAN
    // ════════════════════════════════════════════════════════
    
    let selectedKelasId = null;
    
    function loadManajemenKelas() {
      const el = document.getElementById('section-manajemenKelas');
      el.innerHTML = pageHeaderHtml('Sistem Kontrol Akses', 'Manajemen Kelas', 'Atur tautan media mana saja yang dapat diakses tiap rombongan belajar (rombel).',
        `<button class="btn btn-accent" onclick="promptCreateKelas()"><i class="bi bi-plus-lg"></i> Buat Rombel Baru</button>`)
        + `<div id="manajemenKelasBody"></div>`;
      const cached = AppState.cache.kelasSaya;
      if (cached) { renderManajemenKelas(cached); } else { skeletonBlock('manajemenKelasBody', 3); }
    
      google.script.run
        .withSuccessHandler(res => {
          if (!res.success) { if (!cached) handleBackendError(res); return; }
          AppState.cache.kelasSaya = res.data;
          renderManajemenKelas(res.data);
        })
        .withFailureHandler(err => { if (!cached) handleBackendError(err); })
        .getKelasSaya(AppState.sessionToken);
    }
    
    function renderManajemenKelas(kelasList) {
      const container = document.getElementById('manajemenKelasBody');
      if (!kelasList.length) {
        container.innerHTML = `<div class="empty-state"><i class="bi bi-mortarboard"></i><p class="mt-2">Belum ada rombel. Klik "Buat Rombel Baru" untuk mulai.</p></div>`;
        return;
      }
      if (!selectedKelasId) selectedKelasId = kelasList[0].id;
    
      const listHtml = kelasList.map(k => `
        <div class="card-surface p-3 mb-2" style="cursor:pointer; ${k.id === selectedKelasId ? 'border-color:var(--navy); background:var(--navy-light);' : ''}" onclick="selectKelas('${k.id}')">
          <div class="fw-semibold small">${escapeHtml(k.namaKelas)}</div>
          <div class="text-secondary" style="font-size:.75rem;">${k.jumlahMahasiswa} mahasiswa</div>
          <div class="mt-1"><span class="badge-status badge-info">${k.jumlahMediaTerpilih} media terpilih</span> <span class="badge-status ${k.status === 'Aktif' ? 'badge-success' : 'badge-warning'} ms-1">Token ${k.status}</span></div>
        </div>
      `).join('');
    
      container.innerHTML = `
        <div class="row g-3">
          <div class="col-lg-4">${listHtml}</div>
          <div class="col-lg-8"><div id="kelasDetailPanel"><div class="skeleton" style="height:320px;"></div></div></div>
        </div>`;
      loadKelasDetail(selectedKelasId);
    }
    
    function selectKelas(id) { selectedKelasId = id; renderManajemenKelas(AppState.cache.kelasSaya); }
    
    function loadKelasDetail(idKelas) {
      const cached = AppState.cache.kelasDetail && AppState.cache.kelasDetail[idKelas];
      if (cached) renderKelasDetail(cached);
    
      google.script.run
        .withSuccessHandler(res => {
          if (!res.success) { if (!cached) handleBackendError(res); return; }
          if (!AppState.cache.kelasDetail) AppState.cache.kelasDetail = {};
          AppState.cache.kelasDetail[idKelas] = res.data;
          renderKelasDetail(res.data);
        })
        .withFailureHandler(err => { if (!cached) handleBackendError(err); })
        .getKelasDetail(AppState.sessionToken, idKelas);
    }
    
    function renderKelasDetail(data) {
      const panel = document.getElementById('kelasDetailPanel');
      if (!panel) return;
      const publicUrl = buildGuestLink(data.token);
    
      const checklistHtml = data.links.length ? data.links.map(l => `
        <label class="d-flex align-items-center gap-2 p-2 border rounded mb-1" style="border-color:var(--border-color)!important; cursor:pointer;">
          <input type="checkbox" class="form-check-input m-0" value="${l.id}" ${l.selected ? 'checked' : ''} data-kelas-checkbox>
          <span class="small">${escapeHtml(l.judul)} <span class="text-secondary">• ${escapeHtml(l.kategori || 'Umum')}</span></span>
        </label>
      `).join('') : `<p class="text-secondary small">Anda belum memiliki materi aktif di Katalog Saya.</p>`;
    
      panel.innerHTML = `
        <div class="card-surface p-3 p-md-4">
          <h6 class="fw-bold mb-3">${escapeHtml(data.namaKelas)}</h6>
          <div class="p-3 rounded mb-3" style="background:var(--navy-light);">
            <div class="small fw-semibold mb-2"><i class="bi bi-globe2"></i> Link Publik Akses Mahasiswa (Mode Tamu)</div>
            <div class="d-flex flex-wrap align-items-center gap-2 mb-2">
              <code class="small text-break">${escapeHtml(publicUrl)}</code>
            </div>
            <button class="btn btn-sm btn-navy me-1" onclick="copyToClipboard('${escapeHtml(publicUrl).replace(/'/g, "\\'")}')"><i class="bi bi-clipboard"></i> Salin Link Kelas</button>
            <button class="btn btn-sm btn-outline-navy me-1" onclick="regenToken('${data.id}')"><i class="bi bi-arrow-repeat"></i> Generate Ulang Token</button>
            <button class="btn btn-sm btn-outline-navy me-1" onclick="promptEditKelas('${data.id}', '${escapeHtml(data.namaKelas).replace(/'/g, "\\'")}', ${Number(data.jumlahMahasiswa) || 0})"><i class="bi bi-pencil"></i> Edit Rombel</button>
            <button class="btn btn-sm btn-outline-danger" onclick="deleteKelasHandler('${data.id}', '${escapeHtml(data.namaKelas).replace(/'/g, "\\'")}')"><i class="bi bi-trash3"></i> Hapus Rombel</button>
          </div>
    
          <div class="fw-semibold small mb-2">Pilih Media yang Ditampilkan di Kelas Ini</div>
          <div style="max-height:280px; overflow-y:auto;">${checklistHtml}</div>
    
          <button class="btn btn-accent w-100 mt-3" onclick="saveDistribusi('${data.id}')"><i class="bi bi-save"></i> Simpan Perubahan</button>
        </div>`;
    }
    
    function buildGuestLink(token) {
      // Link tamu HARUS mengarah ke frontend (tempat index.html di-hosting),
      // bukan ke URL backend GAS — backend sekarang murni API JSON, tidak
      // lagi menyajikan halaman HTML apa pun.
      return AppState.baseUrl + '?token=' + token;
    }
    
    function copyToClipboard(text) {
      navigator.clipboard.writeText(text).then(() => showToast('Disalin', 'Tautan berhasil disalin ke clipboard.', 'success'));
    }
    
    function promptCreateKelas() {
      const nama = prompt('Nama Rombel / Kelas (misal: TI-2A : Pemrograman Web Lanjut):');
      if (!nama) return;
      const jumlah = prompt('Jumlah mahasiswa terdaftar (opsional):', '30');
    
      google.script.run
        .withSuccessHandler(res => {
          if (!res.success) return handleBackendError(res);
          showToast('Berhasil', res.message, 'success');
          selectedKelasId = res.data.id;
          loadManajemenKelas();
        })
        .withFailureHandler(handleBackendError)
        .createKelas(AppState.sessionToken, nama, Number(jumlah) || 0);
    }
    
    function promptEditKelas(idKelas, namaSaatIni, jumlahSaatIni) {
      const nama = prompt('Ubah nama Rombel / Kelas:', namaSaatIni);
      if (!nama) return;
      const jumlah = prompt('Ubah jumlah mahasiswa terdaftar:', jumlahSaatIni);
    
      google.script.run
        .withSuccessHandler(res => {
          if (!res.success) return handleBackendError(res);
          showToast('Berhasil', res.message, 'success');
          delete AppState.cache.kelasSaya;
          if (AppState.cache.kelasDetail) delete AppState.cache.kelasDetail[idKelas];
          loadManajemenKelas();
        })
        .withFailureHandler(handleBackendError)
        .updateKelas(AppState.sessionToken, idKelas, nama, Number(jumlah) || 0);
    }
    
    function saveDistribusi(idKelas) {
      const ids = Array.from(document.querySelectorAll('[data-kelas-checkbox]:checked')).map(el => el.value);
      google.script.run
        .withSuccessHandler(res => {
          if (!res.success) return handleBackendError(res);
          showToast('Berhasil', res.message, 'success');
          loadManajemenKelas();
        })
        .withFailureHandler(handleBackendError)
        .saveDistribusiKelas(AppState.sessionToken, idKelas, ids);
    }
    
    function regenToken(idKelas) {
      if (!confirm('Token lama akan langsung tidak berlaku. Lanjutkan?')) return;
      google.script.run
        .withSuccessHandler(res => {
          if (!res.success) return handleBackendError(res);
          showToast('Berhasil', res.message, 'success');
          // Token lama sudah tidak valid — hapus cache agar tidak sempat tampil sekilas
          if (AppState.cache.kelasDetail) delete AppState.cache.kelasDetail[idKelas];
          loadKelasDetail(idKelas);
        })
        .withFailureHandler(handleBackendError)
        .regenerateToken(AppState.sessionToken, idKelas);
    }
    
    function deleteKelasHandler(idKelas, namaKelas) {
      if (!confirm(`Hapus rombel "${namaKelas}"? Link akses mahasiswa untuk rombel ini akan langsung tidak berlaku. Tindakan ini tidak bisa dibatalkan.`)) return;
      google.script.run
        .withSuccessHandler(res => {
          if (!res.success) return handleBackendError(res);
          showToast('Berhasil', res.message, 'success');
          // Bersihkan cache supaya rombel yang baru dihapus tidak sempat tampil
          // sekilas (stale) sebelum daftar disegarkan.
          delete AppState.cache.kelasSaya;
          if (AppState.cache.kelasDetail) delete AppState.cache.kelasDetail[idKelas];
          selectedKelasId = null;
          loadManajemenKelas();
        })
        .withFailureHandler(handleBackendError)
        .deleteKelas(AppState.sessionToken, idKelas);
    }
    
    // ════════════════════════════════════════════════════════
    // BAGIAN 9: REDEEM KODE VIDEO TUTORIAL (Dosen)
    // ════════════════════════════════════════════════════════
    
    function loadRedeemKode() {
      const el = document.getElementById('section-redeemKode');
      el.innerHTML = `
        <div class="mb-3"><span class="badge-khusus"><i class="bi bi-lock"></i> Khusus Dosen</span></div>
        <div class="page-title mb-1">Redeem Kode Video Tutorial</div>
        <div class="page-desc mb-4">Masukkan kode unik dari Admin untuk membuka akses video tutorial eksklusif.</div>
        <div class="row g-3">
          <div class="col-lg-5">
            <div class="card-surface p-4 text-center">
              <i class="bi bi-key" style="font-size:2rem; color:var(--accent);"></i>
              <h6 class="fw-bold mt-2 mb-1">Tukarkan Kode Akses</h6>
              <p class="text-secondary small mb-3">Satu kode hanya berlaku sekali untuk satu akun dosen.</p>
              <form onsubmit="submitRedeem(event)">
                <input type="text" class="form-control redeem-input mb-3" id="redeemKodeInput" placeholder="EDUMEDIA-VOD-2026-X9Q" required>
                <button type="submit" class="btn btn-accent w-100" id="btnRedeemSubmit"><i class="bi bi-check2-circle"></i> Tukarkan Kode Sekarang</button>
              </form>
            </div>
          </div>
          <div class="col-lg-7">
            <div class="fw-semibold small mb-2">Riwayat Redeem Saya</div>
            <div id="redeemHistoryBody"><div class="skeleton" style="height:200px;"></div></div>
          </div>
        </div>`;
      loadRedeemHistory();
    }
    
    function submitRedeem(event) {
      event.preventDefault();
      const input = document.getElementById('redeemKodeInput');
      const btn = document.getElementById('btnRedeemSubmit');
      const original = btn.innerHTML;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Memvalidasi...';
      btn.disabled = true;
    
      google.script.run
        .withSuccessHandler(res => {
          btn.innerHTML = original; btn.disabled = false;
          if (!res.success) { showToast('Gagal', res.message, 'danger'); return; }
          showToast('Berhasil!', res.message, 'success');
          input.value = '';
          // Video yang baru diredeem harus langsung "terbuka" saat dilihat — hapus cache lama
          delete AppState.cache.videoTutorialSaya;
          delete AppState.cache.redeemHistory;
          loadRedeemHistory();
        })
        .withFailureHandler(err => { btn.innerHTML = original; btn.disabled = false; handleBackendError(err); })
        .redeemVideoCode(AppState.sessionToken, input.value.trim());
    }
    
    function loadRedeemHistory() {
      const cached = AppState.cache.redeemHistory;
      if (cached) renderRedeemHistory(cached);
    
      google.script.run
        .withSuccessHandler(res => {
          if (!res.success) { if (!cached) handleBackendError(res); return; }
          AppState.cache.redeemHistory = res.data;
          renderRedeemHistory(res.data);
        })
        .withFailureHandler(err => { if (!cached) handleBackendError(err); })
        .getVideoTutorialSaya(AppState.sessionToken);
    }
    
    function renderRedeemHistory(data) {
      const body = document.getElementById('redeemHistoryBody');
      if (!body) return;
      if (!data.length) { body.innerHTML = `<div class="empty-state"><i class="bi bi-inbox"></i><p class="mt-2">Belum ada video yang diredeem.</p></div>`; return; }
      body.innerHTML = `<div class="table-wrap"><div class="table-responsive"><table class="app-table">
        <thead><tr><th>Judul Video</th><th>Tanggal Redeem</th></tr></thead>
        <tbody>${data.map(v => `<tr><td class="fw-semibold small">${escapeHtml(v.judul)}</td><td class="text-secondary small">${new Date(v.tanggalRedeem).toLocaleString('id-ID')}</td></tr>`).join('')}</tbody>
      </table></div></div>`;
    }
    
    // ════════════════════════════════════════════════════════
    // BAGIAN 10: VIDEO TUTORIAL SAYA (Dosen)
    // ════════════════════════════════════════════════════════
    
    function loadVideoTutorialSaya() {
      const el = document.getElementById('section-videoTutorialSaya');
      el.innerHTML = `
        <div class="mb-3"><span class="badge-khusus"><i class="bi bi-lock"></i> Khusus Dosen</span></div>
        <div class="page-title mb-1">Video Tutorial Saya</div>
        <div class="page-desc mb-4">Seluruh video tutorial yang tersedia di Bank Video — video yang belum diredeem tampil terkunci.</div>
        <div id="videoTutorialBody"></div>`;
      const cached = AppState.cache.videoTutorialSaya;
      if (cached) { renderVideoTutorialSaya(cached); } else { skeletonBlock('videoTutorialBody', 3); }
    
      google.script.run
        .withSuccessHandler(res => {
          if (!res.success) { if (!cached) handleBackendError(res); return; }
          AppState.cache.videoTutorialSaya = res.data;
          renderVideoTutorialSaya(res.data);
        })
        .withFailureHandler(err => { if (!cached) handleBackendError(err); })
        .getSemuaVideoUntukDosen(AppState.sessionToken);
    }
    
    function renderVideoTutorialSaya(videos) {
      const container = document.getElementById('videoTutorialBody');
      if (!videos.length) {
        container.innerHTML = `<div class="empty-state"><i class="bi bi-collection-play"></i><p class="mt-2">Belum ada video di Bank Video.</p></div>`;
        return;
      }
      container.innerHTML = `<div class="row g-3">` + videos.map(v => `
        <div class="col-md-6 col-lg-4">
          <div class="media-card" ${v.locked ? 'style="opacity:.75;"' : ''}>
            <div class="media-thumb">
              ${v.thumbnail ? `<img src="${escapeHtml(v.thumbnail)}" alt="" ${v.locked ? 'style="filter:grayscale(1) brightness(.6);"' : ''}>` : ''}
              <div class="play-overlay">${v.locked ? '<i class="bi bi-lock-fill"></i>' : '<i class="bi bi-play-circle-fill"></i>'}</div>
              <span class="media-cat-badge">${escapeHtml(v.sumber)}</span>
            </div>
            <div class="media-body">
              <div class="media-title">${escapeHtml(v.judul)}</div>
              <div class="media-desc">${escapeHtml(v.deskripsi || '')}</div>
              ${v.locked
                ? `<button class="btn btn-outline-secondary w-100" onclick="navigateTo('redeemKode')"><i class="bi bi-lock-fill"></i> Terkunci — Redeem Dulu</button>`
                : `<button class="btn btn-outline-navy w-100" onclick='playVideo(${JSON.stringify(v).replace(/'/g, "&apos;")})'><i class="bi bi-play-fill"></i> Tonton</button>`
              }
              ${!v.locked && v.lampiran && v.lampiran.length ? `
                <div class="mt-2 d-flex flex-column gap-1">
                  ${v.lampiran.map(l => `<a href="${escapeHtml(l.url)}" target="_blank" rel="noopener" class="btn btn-sm btn-outline-secondary text-start"><i class="bi bi-paperclip"></i> ${escapeHtml(l.label || 'Lampiran')}</a>`).join('')}
                </div>` : ''}
            </div>
          </div>
        </div>`).join('') + `</div>`;
    }
    
    function playVideo(video) {
      document.getElementById('videoPlayerTitle').textContent = video.judul;
      document.getElementById('videoPlayerDesc').textContent = video.deskripsi || '';
      document.getElementById('videoPlayerLampiran').innerHTML = (video.lampiran && video.lampiran.length)
        ? `<div class="small text-white-50 mb-1"><i class="bi bi-paperclip"></i> Lampiran:</div>` +
          video.lampiran.map(l => `<a href="${escapeHtml(l.url)}" target="_blank" rel="noopener" class="btn btn-sm btn-outline-light me-1 mb-1"><i class="bi bi-box-arrow-up-right"></i> ${escapeHtml(l.label || 'Lampiran')}</a>`).join('')
        : '';
      new bootstrap.Modal(document.getElementById('modalVideoPlayer')).show();
    
      google.script.run
        .withSuccessHandler(res => {
          if (!res.success) return;
          document.getElementById('videoPlayerFrame').src = res.data.embedUrl;
        })
        .withFailureHandler(handleBackendError)
        .recordVideoView(AppState.sessionToken, video.id);
    
      document.getElementById('modalVideoPlayer').addEventListener('hidden.bs.modal', function onHide() {
        document.getElementById('videoPlayerFrame').src = '';
        this.removeEventListener('hidden.bs.modal', onHide);
      });
    }
    
    // ════════════════════════════════════════════════════════
    // BAGIAN 11: LAPORAN AKTIVITAS (Dosen)
    // ════════════════════════════════════════════════════════
    
    function loadLaporanAktivitas(periode) {
      periode = periode || 7;
      const el = document.getElementById('section-laporanAktivitas');
      el.innerHTML = pageHeaderHtml('Statistik Real-Time', 'Laporan Aktivitas', 'Pantau rekam jejak akses klik tautan media pembelajaran per rombel.',
        `<select class="form-select form-select-sm" style="width:auto;" onchange="loadLaporanAktivitas(this.value)">
          <option value="7" ${periode == 7 ? 'selected' : ''}>7 Hari Terakhir</option>
          <option value="30" ${periode == 30 ? 'selected' : ''}>30 Hari Terakhir</option>
          <option value="90" ${periode == 90 ? 'selected' : ''}>90 Hari Terakhir</option>
        </select>`)
        + `<div id="laporanDosenBody"></div>`;
      const cacheKey = 'laporanAktivitas_' + periode;
      const cached = AppState.cache[cacheKey];
      if (cached) { renderLaporanDosen(cached); } else { skeletonBlock('laporanDosenBody', 4); }
    
      google.script.run
        .withSuccessHandler(res => {
          if (!res.success) { if (!cached) handleBackendError(res); return; }
          AppState.cache[cacheKey] = res.data;
          renderLaporanDosen(res.data);
        })
        .withFailureHandler(err => { if (!cached) handleBackendError(err); })
        .getLaporanAktivitasDosen(AppState.sessionToken, Number(periode));
    }
    
    function renderLaporanDosen(data) {
      const container = document.getElementById('laporanDosenBody');
      const rows = data.riwayat.map(r => `<tr><td class="small text-secondary">${escapeHtml(r.waktu)}</td><td class="small">${escapeHtml(r.namaKelas)}</td><td class="small fw-semibold">${escapeHtml(r.judulLink)}</td></tr>`).join('');
    
      container.innerHTML = `
        <div class="row g-3 mb-3">
          <div class="col-6 col-md-4"><div class="stat-card"><div class="stat-value">${data.totalKlik}</div><div class="stat-label">Total Klik</div></div></div>
          <div class="col-6 col-md-4"><div class="stat-card"><div class="stat-value" style="font-size:1rem;">${data.materiPalingDiminati ? escapeHtml(data.materiPalingDiminati.judul) : '-'}</div><div class="stat-label">Materi Paling Diminati</div></div></div>
        </div>
        <div class="card-surface p-3 mb-3"><canvas id="chartLaporanDosen" height="90"></canvas></div>
        <div class="fw-semibold small mb-2">Riwayat Log Akses</div>
        <div class="table-wrap"><div class="table-responsive"><table class="app-table">
          <thead><tr><th>Waktu</th><th>Kelas</th><th>Materi</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="3" class="text-center text-secondary py-3">Belum ada aktivitas pada periode ini.</td></tr>'}</tbody>
        </table></div></div>`;
    
      renderBarChart('chartLaporanDosen', data.perHari, 'Klik');
    }
    
    function renderBarChart(canvasId, dataObj, label) {
      const ctx = document.getElementById(canvasId);
      if (!ctx) return;
      if (AppState.chartInstances[canvasId]) AppState.chartInstances[canvasId].destroy();
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      const labels = Object.keys(dataObj);
      const values = Object.values(dataObj);
      AppState.chartInstances[canvasId] = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets: [{ label, data: values, backgroundColor: '#1E3A5F', borderRadius: 6, maxBarThickness: 36 }] },
        options: {
          responsive: true,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: isDark ? '#93A3BC' : '#64748B' }, grid: { display: false } },
            y: { ticks: { color: isDark ? '#93A3BC' : '#64748B' }, grid: { color: isDark ? '#263349' : '#E2E8F0' }, beginAtZero: true }
          }
        }
      });
    }
    
    // ════════════════════════════════════════════════════════
    // BAGIAN 12: TUTORIAL TEKS (baca — Dosen/Admin)
    // ════════════════════════════════════════════════════════
    
    function loadTutorialTeks() {
      const el = document.getElementById('section-tutorialTeks');
      el.innerHTML = pageHeaderHtml('Panduan Penggunaan', 'Tutorial', 'Pelajari cara menggunakan seluruh fitur Portal EduMedia.', '')
        + `<div id="tutorialTeksBody"></div>`;
      const cached = AppState.cache.tutorialTeks;
      if (cached) { renderTutorialTeks(cached); } else { skeletonBlock('tutorialTeksBody', 3); }
    
      google.script.run
        .withSuccessHandler(res => {
          if (!res.success) { if (!cached) handleBackendError(res); return; }
          AppState.cache.tutorialTeks = res.data;
          AppState.cache.kelolaKonten = res.data;
          renderTutorialTeks(res.data);
        })
        .withFailureHandler(err => { if (!cached) handleBackendError(err); })
        .getTutorialKonten(AppState.sessionToken);
    }
    
    let activeTutorialId = null;
    function renderTutorialTeks(list) {
      const container = document.getElementById('tutorialTeksBody');
      if (!list.length) { container.innerHTML = `<div class="empty-state"><i class="bi bi-journal-x"></i><p class="mt-2">Belum ada panduan tersedia.</p></div>`; return; }
      if (!activeTutorialId) activeTutorialId = list[0].id;
      const active = list.find(t => t.id === activeTutorialId) || list[0];
    
      container.innerHTML = `
        <div class="row g-3">
          <div class="col-lg-4">
            ${list.map(t => `<div class="card-surface p-3 mb-2" style="cursor:pointer; ${t.id === active.id ? 'border-color:var(--navy); background:var(--navy-light);' : ''}" onclick="activeTutorialId='${t.id}'; renderTutorialTeks(${JSON.stringify(list).replace(/"/g, '&quot;')})">
              <div class="small fw-semibold">${escapeHtml(t.judul)}</div>
              <div class="text-secondary" style="font-size:.72rem;">${escapeHtml(t.kategori || 'Umum')}</div>
            </div>`).join('')}
          </div>
          <div class="col-lg-8">
            <div class="card-surface p-4">
              <h5 class="fw-bold mb-3">${escapeHtml(active.judul)}</h5>
              <p style="white-space:pre-wrap; line-height:1.7;">${escapeHtml(active.konten)}</p>
            </div>
          </div>
        </div>`;
    }
    
    // ════════════════════════════════════════════════════════
    // BAGIAN 13: ADMIN — DASHBOARD
    // ════════════════════════════════════════════════════════
    
    function loadAdminDashboard() {
      const el = document.getElementById('section-adminDashboard');
      el.innerHTML = pageHeaderHtml('Pusat Kendali Sistem', 'Dasbor Administrator', 'Pantau distribusi media ajar dan aktivitas seluruh portal secara real-time.', '')
        + `<div id="adminDashboardBody"></div>`;
      const cached = AppState.cache.adminDashboard;
      if (cached) { renderAdminDashboard(cached); } else { skeletonBlock('adminDashboardBody', 4); }
    
      google.script.run
        .withSuccessHandler(res => {
          if (!res.success) { if (!cached) handleBackendError(res); return; }
          AppState.cache.adminDashboard = res.data;
          renderAdminDashboard(res.data);
        })
        .withFailureHandler(err => { if (!cached) handleBackendError(err); })
        .getAdminDashboardData(AppState.sessionToken);
    }
    
    function renderAdminDashboard(data) {
      const container = document.getElementById('adminDashboardBody');
      const redeemRows = data.redeemTerbaru.map(r => `
        <div class="d-flex justify-content-between align-items-center py-2" style="border-bottom:1px solid var(--border-color);">
          <div><div class="small fw-semibold">${escapeHtml(r.dosen)}</div><div class="text-secondary" style="font-size:.72rem;">${escapeHtml(r.kode)}</div></div>
          <div class="text-secondary small">${escapeHtml(r.tanggal)}</div>
        </div>`).join('') || '<p class="text-secondary small mb-0">Belum ada redeem.</p>';
    
      container.innerHTML = `
        <div class="row g-3 mb-3">
          <div class="col-6 col-md-3"><div class="stat-card"><div class="stat-icon mb-2"><i class="bi bi-mortarboard"></i></div><div class="stat-value">${data.totalDosen}</div><div class="stat-label">Dosen Aktif</div></div></div>
          <div class="col-6 col-md-3"><div class="stat-card"><div class="stat-icon mb-2"><i class="bi bi-people"></i></div><div class="stat-value">${data.totalKelas}</div><div class="stat-label">Total Kelas</div></div></div>
          <div class="col-6 col-md-3"><div class="stat-card"><div class="stat-icon mb-2"><i class="bi bi-cursor"></i></div><div class="stat-value">${data.klikBulanIni}</div><div class="stat-label">Klik Bulan Ini</div></div></div>
          <div class="col-6 col-md-3"><div class="stat-card"><div class="stat-icon mb-2"><i class="bi bi-key"></i></div><div class="stat-value">${data.kodeAktif}</div><div class="stat-label">Kode Redeem Aktif</div></div></div>
        </div>
        <div class="row g-3">
          <div class="col-lg-8"><div class="card-surface p-3"><div class="fw-semibold small mb-2">Tren Aktivitas Portal (30 Hari)</div><canvas id="chartAdminTren" height="100"></canvas></div></div>
          <div class="col-lg-4"><div class="card-surface p-3"><div class="fw-semibold small mb-2">Redeem Video Terbaru</div>${redeemRows}</div></div>
        </div>`;
    
      renderLineChart('chartAdminTren', data.perHari, 'Klik');
    }
    
    function renderLineChart(canvasId, dataObj, label) {
      const ctx = document.getElementById(canvasId);
      if (!ctx) return;
      if (AppState.chartInstances[canvasId]) AppState.chartInstances[canvasId].destroy();
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      AppState.chartInstances[canvasId] = new Chart(ctx, {
        type: 'line',
        data: { labels: Object.keys(dataObj), datasets: [{ label, data: Object.values(dataObj), borderColor: '#F5A623', backgroundColor: 'rgba(245,166,35,0.15)', fill: true, tension: .35, pointRadius: 2 }] },
        options: { responsive: true, plugins: { legend: { display: false } },
          scales: { x: { ticks: { color: isDark ? '#93A3BC' : '#64748B' }, grid: { display: false } }, y: { ticks: { color: isDark ? '#93A3BC' : '#64748B' }, grid: { color: isDark ? '#263349' : '#E2E8F0' }, beginAtZero: true } } }
      });
    }
    
    // ════════════════════════════════════════════════════════
    // BAGIAN 14: ADMIN — MANAJEMEN USER & AKSES SILANG
    // ════════════════════════════════════════════════════════
    
    function loadManajemenUser() {
      const el = document.getElementById('section-manajemenUser');
      el.innerHTML = pageHeaderHtml('Modul Administrasi Portal', 'Manajemen User & Akses Silang', 'Kelola akun Dosen/Admin serta izin akses silang katalog.',
        `<button class="btn btn-accent" onclick="openUserForm()"><i class="bi bi-person-plus"></i> Tambah Pengguna</button>`)
        + `<div id="manajemenUserBody"></div>`;
      const cached = AppState.cache.users;
      if (cached) { renderManajemenUser(cached); } else { skeletonBlock('manajemenUserBody', 4); }
    
      google.script.run
        .withSuccessHandler(res => {
          if (!res.success) { if (!cached) handleBackendError(res); return; }
          AppState.cache.users = res.data;
          renderManajemenUser(res.data);
        })
        .withFailureHandler(err => { if (!cached) handleBackendError(err); })
        .getAllUsers(AppState.sessionToken);
    }
    
    function renderManajemenUser(users) {
      const container = document.getElementById('manajemenUserBody');
      const rows = users.map(u => `
        <tr>
          <td><div class="fw-semibold small">${escapeHtml(u.nama)}</div><div class="text-secondary" style="font-size:.72rem;">${escapeHtml(u.email)}</div></td>
          <td class="small text-secondary">${escapeHtml(u.nidn || '-')}</td>
          <td class="small">
            <span class="font-monospace" id="pwd-${u.id}" data-pwd="${escapeHtml(u.password)}" data-visible="false">••••••••</span>
            <button type="button" class="btn btn-sm btn-link p-0 ms-1 align-baseline" onclick="togglePasswordVisibility('${u.id}')" title="Tampilkan/Sembunyikan kata sandi">
              <i class="bi bi-eye" id="pwd-icon-${u.id}"></i>
            </button>
          </td>
          <td><span class="badge-status ${u.role === 'Admin' ? 'badge-lecturer' : 'badge-info'}">${u.role}</span></td>
          <td class="small text-secondary">${u.aksesSilang.length ? u.aksesSilang.map(id => { const d = users.find(x => x.id === id); return d ? escapeHtml(d.nama) : ''; }).filter(Boolean).join(', ') : '<span class="text-muted">Belum ada</span>'}</td>
          <td class="text-end">
            <button class="btn btn-sm btn-outline-navy me-1" onclick='openUserForm(${JSON.stringify(u).replace(/'/g, "&apos;")})'><i class="bi bi-pencil"></i></button>
            <button class="btn btn-sm btn-outline-secondary" onclick="confirmDeleteUser('${u.id}', '${escapeHtml(u.nama).replace(/'/g, "\\'")}')"><i class="bi bi-trash text-danger"></i></button>
          </td>
        </tr>`).join('');
    
      container.innerHTML = `<div class="table-wrap"><div class="table-responsive"><table class="app-table">
        <thead><tr><th>Nama &amp; Email</th><th>NIDN</th><th>Kata Sandi</th><th>Role</th><th>Akses Silang</th><th class="text-end">Aksi</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div></div>`;
    }
    
    function togglePasswordVisibility(id) {
      const span = document.getElementById('pwd-' + id);
      const icon = document.getElementById('pwd-icon-' + id);
      const visible = span.dataset.visible === 'true';
      if (visible) {
        span.textContent = '••••••••';
        span.dataset.visible = 'false';
        icon.className = 'bi bi-eye';
      } else {
        span.textContent = span.dataset.pwd;
        span.dataset.visible = 'true';
        icon.className = 'bi bi-eye-slash';
      }
    }
    
    function openUserForm(data) {
      document.getElementById('formUser').reset();
      const options = (AppState.cache.users || []).filter(u => u.role === 'Dosen' && (!data || u.id !== data.id))
        .map(u => `<option value="${u.id}">${escapeHtml(u.nama)}</option>`).join('');
      document.getElementById('userAksesSilang').innerHTML = options;
    
      if (data) {
        document.getElementById('modalUserFormTitle').innerHTML = '<i class="bi bi-pencil"></i> Edit Pengguna';
        document.getElementById('userId').value = data.id;
        document.getElementById('userNama').value = data.nama;
        document.getElementById('userEmail').value = data.email;
        document.getElementById('userNidn').value = data.nidn || '';
        document.getElementById('userRole').value = data.role;
        document.getElementById('userPassword').removeAttribute('required');
        Array.from(document.getElementById('userAksesSilang').options).forEach(o => { o.selected = data.aksesSilang.includes(o.value); });
      } else {
        document.getElementById('modalUserFormTitle').innerHTML = '<i class="bi bi-person-plus"></i> Tambah Pengguna';
        document.getElementById('userId').value = '';
      }
      new bootstrap.Modal(document.getElementById('modalUserForm')).show();
    }
    
    function submitUserForm(event) {
      event.preventDefault();
      const record = {
        id: document.getElementById('userId').value || null,
        nama: document.getElementById('userNama').value.trim(),
        email: document.getElementById('userEmail').value.trim(),
        nidn: document.getElementById('userNidn').value.trim(),
        role: document.getElementById('userRole').value,
        password: document.getElementById('userPassword').value.trim(),
        aksesSilang: Array.from(document.getElementById('userAksesSilang').selectedOptions).map(o => o.value)
      };
      google.script.run
        .withSuccessHandler(res => {
          if (!res.success) return handleBackendError(res);
          bootstrap.Modal.getInstance(document.getElementById('modalUserForm')).hide();
          showToast('Berhasil', res.message, 'success');
          loadManajemenUser();
        })
        .withFailureHandler(handleBackendError)
        .saveUser(AppState.sessionToken, record);
    }
    
    function confirmDeleteUser(id, nama) {
      document.getElementById('modalConfirmText').textContent = `Hapus pengguna "${nama}"?`;
      document.getElementById('btnModalConfirmAction').onclick = () => {
        google.script.run
          .withSuccessHandler(res => {
            bootstrap.Modal.getInstance(document.getElementById('modalConfirm')).hide();
            if (!res.success) return handleBackendError(res);
            showToast('Berhasil', res.message, 'success');
            loadManajemenUser();
          })
          .withFailureHandler(handleBackendError)
          .deleteUser(AppState.sessionToken, id);
      };
      new bootstrap.Modal(document.getElementById('modalConfirm')).show();
    }
    
    // ════════════════════════════════════════════════════════
    // BAGIAN 15: ADMIN — BANK VIDEO TUTORIAL & KODE REDEEM
    // ════════════════════════════════════════════════════════
    
    function loadBankVideoTutorial() {
      const el = document.getElementById('section-bankVideoTutorial');
      el.innerHTML = pageHeaderHtml('Modul Administrasi', 'Bank Video Tutorial &amp; Manajemen Kode Redeem', 'Kelola repositori video panduan untuk dosen dan generate kode redeem unik.',
        `<button class="btn btn-accent" onclick="openAddVideoModal()"><i class="bi bi-plus-lg"></i> Tambah Video Baru</button>`)
        + `<div id="bankVideoBody"></div>`;
      const cached = AppState.cache.bankVideo;
      if (cached) { renderBankVideo(cached); } else { skeletonBlock('bankVideoBody', 4); }
    
      google.script.run
        .withSuccessHandler(res => {
          if (!res.success) { if (!cached) handleBackendError(res); return; }
          AppState.cache.bankVideo = res.data;
          renderBankVideo(res.data);
        })
        .withFailureHandler(err => { if (!cached) handleBackendError(err); })
        .getBankVideo(AppState.sessionToken);
    }
    
    function renderBankVideo(videos) {
      const container = document.getElementById('bankVideoBody');
      const totalKode = videos.reduce((s, v) => s + v.jumlahKode, 0);
      const totalTerpakai = videos.reduce((s, v) => s + v.jumlahTerpakai, 0);
    
      const statRow = `<div class="row g-3 mb-3">
        <div class="col-6 col-md-3"><div class="stat-card"><div class="stat-value">${videos.length}</div><div class="stat-label">Total Video</div></div></div>
        <div class="col-6 col-md-3"><div class="stat-card"><div class="stat-value">${totalKode}</div><div class="stat-label">Kode Digenerate</div></div></div>
        <div class="col-6 col-md-3"><div class="stat-card"><div class="stat-value">${totalTerpakai}</div><div class="stat-label">Kode Terpakai</div></div></div>
      </div>`;
    
      if (!videos.length) { container.innerHTML = statRow + `<div class="empty-state"><i class="bi bi-collection-play"></i><p class="mt-2">Belum ada video di Bank Video.</p></div>`; return; }
    
      const rows = videos.map(v => `
        <tr>
          <td><img class="table-thumb" src="${escapeHtml(v.thumbnail || '')}" alt=""></td>
          <td class="fw-semibold small">${escapeHtml(v.judul)}${v.lampiran && v.lampiran.length ? ` <span class="badge-status badge-info">${v.lampiran.length} lampiran</span>` : ''}</td>
          <td><span class="badge-status ${v.sumber === 'YouTube' ? 'badge-danger' : v.sumber === 'GoogleDrive' ? 'badge-success' : 'badge-info'}">${v.sumber}</span></td>
          <td><span class="badge-status ${v.status === 'Aktif' ? 'badge-success' : 'badge-warning'}">${v.status}</span></td>
          <td class="small text-secondary">${v.jumlahTerpakai}/${v.jumlahKode} terpakai</td>
          <td class="text-end">
            <button class="btn btn-sm btn-accent me-1" onclick='openGenerateKodeModal("${v.id}", ${JSON.stringify(v.judul).replace(/'/g, "&apos;")})'><i class="bi bi-key"></i> Generate Kode</button>
            <button class="btn btn-sm btn-outline-navy me-1" onclick='openEditVideoModal(${JSON.stringify(v).replace(/'/g, "&apos;")})' title="Edit video"><i class="bi bi-pencil"></i></button>
            <button class="btn btn-sm btn-outline-secondary" onclick="toggleVideoStatus('${v.id}')"><i class="bi bi-power"></i></button>
          </td>
        </tr>`).join('');
    
      container.innerHTML = statRow + `<div class="table-wrap"><div class="table-responsive"><table class="app-table">
        <thead><tr><th></th><th>Judul Video</th><th>Sumber</th><th>Status</th><th>Kode</th><th class="text-end">Aksi</th></tr></thead>
        <tbody>${rows}</tbody></table></div></div>`;
    }
    
    function openAddVideoModal() {
      document.getElementById('formAddVideo').reset();
      document.getElementById('videoEditId').value = '';
      document.getElementById('modalAddVideoTitle').innerHTML = '<i class="bi bi-collection-play"></i> Tambah Video Tutorial';
      document.getElementById('videoLampiranList').innerHTML = '';
      new bootstrap.Modal(document.getElementById('modalAddVideo')).show();
    }
    
    function openEditVideoModal(video) {
      document.getElementById('formAddVideo').reset();
      document.getElementById('videoEditId').value = video.id;
      document.getElementById('modalAddVideoTitle').innerHTML = '<i class="bi bi-pencil"></i> Edit Video Tutorial';
      document.getElementById('videoJudul').value = video.judul || '';
      document.getElementById('videoDeskripsi').value = video.deskripsi || '';
      document.getElementById('videoUrl').value = video.url || '';
      document.getElementById('videoThumbnail').value = video.thumbnail || '';
      document.getElementById('videoLampiranList').innerHTML = '';
      (video.lampiran || []).forEach(l => addLampiranRow(l.label, l.url));
      new bootstrap.Modal(document.getElementById('modalAddVideo')).show();
    }
    
    function addLampiranRow(label, url) {
      const wrap = document.getElementById('videoLampiranList');
      const row = document.createElement('div');
      row.className = 'input-group input-group-sm mb-2 lampiran-row';
      row.innerHTML = `
        <input type="text" class="form-control lampiran-label" placeholder="Label (misal: Modul PDF)" value="${escapeHtml(label || '')}">
        <input type="url" class="form-control lampiran-url" placeholder="https://..." value="${escapeHtml(url || '')}">
        <button type="button" class="btn btn-outline-danger" onclick="this.closest('.lampiran-row').remove()"><i class="bi bi-trash"></i></button>`;
      wrap.appendChild(row);
    }
    
    function submitAddVideo(event) {
      event.preventDefault();
      const lampiran = Array.from(document.querySelectorAll('#videoLampiranList .lampiran-row'))
        .map(row => ({
          label: row.querySelector('.lampiran-label').value.trim(),
          url: row.querySelector('.lampiran-url').value.trim()
        }))
        .filter(l => l.url);
      const editId = document.getElementById('videoEditId').value;
      const record = {
        judul: document.getElementById('videoJudul').value.trim(),
        deskripsi: document.getElementById('videoDeskripsi').value.trim(),
        url: document.getElementById('videoUrl').value.trim(),
        thumbnail: document.getElementById('videoThumbnail').value.trim(),
        lampiran: lampiran
      };
      if (editId) record.id = editId;
      google.script.run
        .withSuccessHandler(res => {
          if (!res.success) { showToast('Gagal', res.message, 'danger'); return; }
          bootstrap.Modal.getInstance(document.getElementById('modalAddVideo')).hide();
          showToast('Berhasil', res.message, 'success');
          delete AppState.cache.bankVideo;
          loadBankVideoTutorial();
        })
        .withFailureHandler(handleBackendError)
        .saveBankVideo(AppState.sessionToken, record);
    }
    
    function toggleVideoStatus(id) {
      google.script.run
        .withSuccessHandler(res => { if (!res.success) return handleBackendError(res); showToast('Berhasil', res.message, 'success'); loadBankVideoTutorial(); })
        .withFailureHandler(handleBackendError)
        .toggleVideoStatus(AppState.sessionToken, id);
    }
    
    let generateKodeTargetId = null;
    function openGenerateKodeModal(idVideo, judul) {
      generateKodeTargetId = idVideo;
      document.getElementById('generateKodeVideoLabel').innerHTML = `<i class="bi bi-play-btn"></i> ${escapeHtml(judul)}`;
      document.getElementById('generateKodeResultBox').style.display = 'none';
      new bootstrap.Modal(document.getElementById('modalGenerateKode')).show();
    }
    
    function confirmGenerateKode() {
      const btn = document.getElementById('btnGenerateKodeAction');
      const original = btn.innerHTML;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Membuat kode...';
      btn.disabled = true;
    
      google.script.run
        .withSuccessHandler(res => {
          btn.innerHTML = original; btn.disabled = false;
          if (!res.success) return handleBackendError(res);
          document.getElementById('generateKodeResultBox').style.display = 'block';
          document.getElementById('generateKodeResultText').textContent = res.data.kode;
          showToast('Berhasil', res.message, 'success');
          loadBankVideoTutorial();
        })
        .withFailureHandler(err => { btn.innerHTML = original; btn.disabled = false; handleBackendError(err); })
        .generateKodeRedeem(AppState.sessionToken, generateKodeTargetId);
    }
    
    function copyGeneratedCode() {
      copyToClipboard(document.getElementById('generateKodeResultText').textContent);
    }
    
    // ════════════════════════════════════════════════════════
    // BAGIAN 16: ADMIN — KELOLA KONTEN TUTORIAL
    // ════════════════════════════════════════════════════════
    
    function loadKelolaKontenTutorial() {
      const el = document.getElementById('section-kelolaKontenTutorial');
      el.innerHTML = pageHeaderHtml('Manajemen Konten Panduan', 'Kelola Konten Tutorial', 'Kelola artikel panduan yang tampil di halaman Tutorial untuk seluruh Dosen.',
        `<button class="btn btn-accent" onclick="openTutorialForm()"><i class="bi bi-plus-lg"></i> Tulis Panduan Baru</button>`)
        + `<div id="kelolaKontenBody"></div>`;
      const cached = AppState.cache.kelolaKonten;
      if (cached) { renderKelolaKonten(cached); } else { skeletonBlock('kelolaKontenBody', 3); }
    
      google.script.run
        .withSuccessHandler(res => {
          if (!res.success) { if (!cached) handleBackendError(res); return; }
          AppState.cache.kelolaKonten = res.data;
          // Tutorial Teks (Dosen) memakai data yang sama — sinkronkan agar tetap konsisten
          AppState.cache.tutorialTeks = res.data;
          renderKelolaKonten(res.data);
        })
        .withFailureHandler(err => { if (!cached) handleBackendError(err); })
        .getTutorialKonten(AppState.sessionToken);
    }
    
    function renderKelolaKonten(list) {
      const container = document.getElementById('kelolaKontenBody');
      if (!list.length) { container.innerHTML = `<div class="empty-state"><i class="bi bi-journal-x"></i><p class="mt-2">Belum ada panduan.</p></div>`; return; }
    
      container.innerHTML = list.map(t => `
        <div class="card-surface p-3 mb-2 d-flex flex-row justify-content-between align-items-start flex-wrap gap-2">
          <div>
            <div class="fw-semibold small">${escapeHtml(t.judul)}</div>
            <div class="text-secondary" style="font-size:.72rem;">${escapeHtml(t.kategori || 'Umum')} • Diperbarui ${new Date(t.urutan ? Date.now() : Date.now()).toLocaleDateString('id-ID')}</div>
          </div>
          <div>
            <button class="btn btn-sm btn-outline-navy me-1" onclick='openTutorialForm(${JSON.stringify(t).replace(/'/g, "&apos;")})'><i class="bi bi-pencil"></i> Edit</button>
            <button class="btn btn-sm btn-outline-secondary" onclick="confirmDeleteTutorial('${t.id}', '${escapeHtml(t.judul).replace(/'/g, "\\'")}')"><i class="bi bi-trash text-danger"></i></button>
          </div>
        </div>`).join('');
    }
    
    function openTutorialForm(data) {
      document.getElementById('formTutorial').reset();
      if (data) {
        document.getElementById('modalTutorialFormTitle').innerHTML = '<i class="bi bi-pencil"></i> Edit Panduan';
        document.getElementById('tutorialId').value = data.id;
        document.getElementById('tutorialJudul').value = data.judul;
        document.getElementById('tutorialKategori').value = data.kategori || '';
        document.getElementById('tutorialKonten').value = data.konten;
      } else {
        document.getElementById('modalTutorialFormTitle').innerHTML = '<i class="bi bi-pencil-square"></i> Tulis Panduan Baru';
        document.getElementById('tutorialId').value = '';
      }
      new bootstrap.Modal(document.getElementById('modalTutorialForm')).show();
    }
    
    function submitTutorialForm(event) {
      event.preventDefault();
      const record = {
        id: document.getElementById('tutorialId').value || null,
        judul: document.getElementById('tutorialJudul').value.trim(),
        kategori: document.getElementById('tutorialKategori').value.trim(),
        konten: document.getElementById('tutorialKonten').value.trim()
      };
      google.script.run
        .withSuccessHandler(res => {
          if (!res.success) return handleBackendError(res);
          bootstrap.Modal.getInstance(document.getElementById('modalTutorialForm')).hide();
          showToast('Berhasil', res.message, 'success');
          loadKelolaKontenTutorial();
        })
        .withFailureHandler(handleBackendError)
        .saveTutorialKonten(AppState.sessionToken, record);
    }
    
    function confirmDeleteTutorial(id, judul) {
      document.getElementById('modalConfirmText').textContent = `Hapus panduan "${judul}"?`;
      document.getElementById('btnModalConfirmAction').onclick = () => {
        google.script.run
          .withSuccessHandler(res => {
            bootstrap.Modal.getInstance(document.getElementById('modalConfirm')).hide();
            if (!res.success) return handleBackendError(res);
            showToast('Berhasil', res.message, 'success');
            loadKelolaKontenTutorial();
          })
          .withFailureHandler(handleBackendError)
          .deleteTutorialKonten(AppState.sessionToken, id);
      };
      new bootstrap.Modal(document.getElementById('modalConfirm')).show();
    }
    
    // ════════════════════════════════════════════════════════
    // BAGIAN 17: ADMIN — LAPORAN GLOBAL
    // ════════════════════════════════════════════════════════
    
    function loadLaporanGlobal() {
      const el = document.getElementById('section-laporanGlobal');
      el.innerHTML = pageHeaderHtml('Modul Administrasi', 'Laporan Aktivitas Global', 'Rekapitulasi komprehensif akses media interaktif seluruh dosen dan kelas.', '')
        + `<div class="row g-2 mb-3">
            <div class="col-auto">
              <select class="form-select form-select-sm" id="filterGlobalDosen" onchange="loadLaporanGlobalData()"><option value="">Semua Dosen</option></select>
            </div>
            <div class="col-auto">
              <select class="form-select form-select-sm" id="filterGlobalPeriode" onchange="loadLaporanGlobalData()">
                <option value="7">7 Hari</option><option value="30" selected>30 Hari</option><option value="90">90 Hari</option>
              </select>
            </div>
          </div>`
        + `<div id="laporanGlobalBody"></div>`;
      loadLaporanGlobalData();
    }
    
    function loadLaporanGlobalData() {
      const idDosen = document.getElementById('filterGlobalDosen') ? document.getElementById('filterGlobalDosen').value : '';
      const periodeHari = document.getElementById('filterGlobalPeriode') ? Number(document.getElementById('filterGlobalPeriode').value) : 30;
      const cacheKey = 'laporanGlobal_' + idDosen + '_' + periodeHari;
      const cached = AppState.cache[cacheKey];
      if (cached) { renderLaporanGlobal(cached); } else { skeletonBlock('laporanGlobalBody', 4); }
    
      google.script.run
        .withSuccessHandler(res => {
          if (!res.success) { if (!cached) handleBackendError(res); return; }
          AppState.cache[cacheKey] = res.data;
          renderLaporanGlobal(res.data);
        })
        .withFailureHandler(err => { if (!cached) handleBackendError(err); })
        .getLaporanGlobal(AppState.sessionToken, { idDosen, periodeHari });
    }
    
    function renderLaporanGlobal(data) {
      const dosenSelect = document.getElementById('filterGlobalDosen');
      if (dosenSelect && dosenSelect.options.length <= 1) {
        dosenSelect.innerHTML = '<option value="">Semua Dosen</option>' + data.daftarDosen.map(d => `<option value="${d.id}">${escapeHtml(d.nama)}</option>`).join('');
      }
    
      const container = document.getElementById('laporanGlobalBody');
      const rows = data.riwayat.map(r => `<tr><td class="small text-secondary">${escapeHtml(r.waktu)}</td><td class="small fw-semibold">${escapeHtml(r.dosen)}</td><td class="small">${escapeHtml(r.kelas)}</td><td class="small">${escapeHtml(r.judulLink)}</td></tr>`).join('');
    
      container.innerHTML = `
        <div class="row g-3 mb-3"><div class="col-6 col-md-3"><div class="stat-card"><div class="stat-value">${data.totalInteraksi}</div><div class="stat-label">Total Interaksi</div></div></div></div>
        <div class="card-surface p-3 mb-3"><div class="fw-semibold small mb-2">Aktivitas Klik per Kelas</div><canvas id="chartGlobalKelas" height="90"></canvas></div>
        <div class="fw-semibold small mb-2">Audit Jejak Aktivitas</div>
        <div class="table-wrap"><div class="table-responsive"><table class="app-table">
          <thead><tr><th>Waktu</th><th>Dosen</th><th>Kelas</th><th>Materi</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="4" class="text-center text-secondary py-3">Tidak ada data pada rentang ini.</td></tr>'}</tbody>
        </table></div></div>`;
    
      renderBarChart('chartGlobalKelas', data.perKelas, 'Klik');
    }
    
    // ════════════════════════════════════════════════════════
    // BAGIAN 17b: MONITORING KATALOG & KELAS (Admin) — pengganti
    // Katalog Saya/Manajemen Kelas pribadi Admin. Melihat & mengontrol
    // seluruh katalog+kelas SEMUA dosen dari satu tempat.
    // ════════════════════════════════════════════════════════
    
    function loadMonitoringKatalogKelas() {
      const el = document.getElementById('section-monitoringKatalogKelas');
      el.innerHTML = pageHeaderHtml('Kontrol Terpusat', 'Monitoring Katalog & Kelas', 'Pantau dan kelola seluruh materi serta rombel dari semua dosen di satu tempat.', '')
        + `<ul class="nav nav-tabs mb-3" id="monitoringTabs">
             <li class="nav-item"><button class="nav-link active" data-tab="katalog" onclick="switchMonitoringTab('katalog')">Semua Katalog Media</button></li>
             <li class="nav-item"><button class="nav-link" data-tab="kelas" onclick="switchMonitoringTab('kelas')">Semua Rombel/Kelas</button></li>
           </ul>
           <div id="monitoringTabKatalog"><div id="monitoringKatalogBody"></div></div>
           <div id="monitoringTabKelas" style="display:none;"><div id="monitoringKelasBody"></div></div>`;
    
      const cachedKatalog = AppState.cache.monitoringKatalog;
      const cachedKelas = AppState.cache.monitoringKelas;
      if (cachedKatalog) { renderMonitoringKatalog(cachedKatalog); } else { skeletonBlock('monitoringKatalogBody', 4); }
      if (cachedKelas) { renderMonitoringKelas(cachedKelas); } else { skeletonBlock('monitoringKelasBody', 3); }
    
      google.script.run
        .withSuccessHandler(res => {
          if (!res.success) { if (!cachedKatalog) handleBackendError(res); return; }
          AppState.cache.monitoringKatalog = res.data;
          renderMonitoringKatalog(res.data);
        })
        .withFailureHandler(err => { if (!cachedKatalog) handleBackendError(err); })
        .getKatalogSemuaDosen(AppState.sessionToken);
    
      google.script.run
        .withSuccessHandler(res => {
          if (!res.success) { if (!cachedKelas) handleBackendError(res); return; }
          AppState.cache.monitoringKelas = res.data;
          renderMonitoringKelas(res.data);
        })
        .withFailureHandler(err => { if (!cachedKelas) handleBackendError(err); })
        .getKelasSemuaDosen(AppState.sessionToken);
    }
    
    function switchMonitoringTab(tab) {
      document.querySelectorAll('#monitoringTabs .nav-link').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
      document.getElementById('monitoringTabKatalog').style.display = tab === 'katalog' ? 'block' : 'none';
      document.getElementById('monitoringTabKelas').style.display = tab === 'kelas' ? 'block' : 'none';
    }
    
    function renderMonitoringKatalog(list) {
      const body = document.getElementById('monitoringKatalogBody');
      if (!body) return;
      if (!list.length) { body.innerHTML = `<div class="empty-state"><i class="bi bi-inbox"></i><p class="mt-2">Belum ada materi dari dosen mana pun.</p></div>`; return; }
      body.innerHTML = `<div class="table-wrap"><div class="table-responsive"><table class="app-table">
        <thead><tr><th>Dosen Pemilik</th><th>Judul Materi</th><th>Kategori</th><th>Kelas Terhubung</th><th>Status</th><th class="text-end">Aksi</th></tr></thead>
        <tbody>${list.map(l => `
          <tr>
            <td class="small">${escapeHtml(l.namaPemilik)}</td>
            <td class="fw-semibold small">${escapeHtml(l.judul)}</td>
            <td class="small text-secondary">${escapeHtml(l.kategori)}</td>
            <td class="small text-secondary">${l.kelasTerhubung.length ? escapeHtml(l.kelasTerhubung.join(', ')) : '—'}</td>
            <td><span class="badge-status ${l.status === 'Aktif' ? 'badge-success' : 'badge-warning'}">${l.status}</span></td>
            <td class="text-end">
              <a href="${escapeHtml(l.tautan)}" target="_blank" rel="noopener" class="btn btn-sm btn-outline-navy me-1" title="Buka media di tab baru"><i class="bi bi-box-arrow-up-right"></i></a>
              <button class="btn btn-sm ${l.status === 'Aktif' ? 'btn-outline-secondary' : 'btn-outline-success'}" onclick="toggleKatalogStatusAdmin('${l.id}')" title="${l.status === 'Aktif' ? 'Nonaktifkan' : 'Aktifkan'} materi ini"><i class="bi bi-power"></i></button>
            </td>
          </tr>`).join('')}</tbody>
      </table></div></div>`;
    }
    
    function toggleKatalogStatusAdmin(id) {
      google.script.run
        .withSuccessHandler(res => {
          if (!res.success) return handleBackendError(res);
          showToast('Berhasil', res.message, 'success');
          delete AppState.cache.monitoringKatalog;
          loadMonitoringKatalogKelas();
        })
        .withFailureHandler(handleBackendError)
        .toggleKatalogLinkStatus(AppState.sessionToken, id);
    }
    
    function renderMonitoringKelas(list) {
      const body = document.getElementById('monitoringKelasBody');
      if (!body) return;
      if (!list.length) { body.innerHTML = `<div class="empty-state"><i class="bi bi-inbox"></i><p class="mt-2">Belum ada rombel dari dosen mana pun.</p></div>`; return; }
      body.innerHTML = `<div class="table-wrap"><div class="table-responsive"><table class="app-table">
        <thead><tr><th>Dosen Pengampu</th><th>Nama Rombel</th><th>Mahasiswa</th><th>Media Terpilih</th><th>Status</th><th class="text-end">Aksi</th></tr></thead>
        <tbody>${list.map(k => `
          <tr>
            <td class="small">${escapeHtml(k.namaPengampu)}</td>
            <td class="fw-semibold small">${escapeHtml(k.namaKelas)}</td>
            <td class="small text-secondary">${k.jumlahMahasiswa}</td>
            <td class="small text-secondary">${k.jumlahMediaTerpilih} media</td>
            <td><span class="badge-status ${k.status === 'Aktif' ? 'badge-success' : 'badge-warning'}">${k.status}</span></td>
            <td class="text-end">
              <button class="btn btn-sm btn-outline-navy me-1" onclick="copyToClipboard('${escapeHtml(AppState.baseUrl + '?token=' + k.token)}')" title="Salin link kelas"><i class="bi bi-clipboard"></i></button>
              <button class="btn btn-sm btn-outline-navy me-1" onclick="adminRegenToken('${k.id}')" title="Generate ulang token"><i class="bi bi-arrow-repeat"></i></button>
              <button class="btn btn-sm btn-outline-danger" onclick="adminDeleteKelas('${k.id}', '${escapeHtml(k.namaKelas).replace(/'/g, "\\'")}')" title="Hapus rombel"><i class="bi bi-trash3"></i></button>
            </td>
          </tr>`).join('')}</tbody>
      </table></div></div>`;
    }
    
    function adminRegenToken(idKelas) {
      if (!confirm('Token lama akan langsung tidak berlaku. Lanjutkan?')) return;
      google.script.run
        .withSuccessHandler(res => {
          if (!res.success) return handleBackendError(res);
          showToast('Berhasil', res.message, 'success');
          delete AppState.cache.monitoringKelas;
          loadMonitoringKatalogKelas();
        })
        .withFailureHandler(handleBackendError)
        .regenerateToken(AppState.sessionToken, idKelas);
    }
    
    function adminDeleteKelas(idKelas, namaKelas) {
      if (!confirm(`Hapus rombel "${namaKelas}"? Link akses mahasiswa untuk rombel ini akan langsung tidak berlaku. Tindakan ini tidak bisa dibatalkan.`)) return;
      google.script.run
        .withSuccessHandler(res => {
          if (!res.success) return handleBackendError(res);
          showToast('Berhasil', res.message, 'success');
          delete AppState.cache.monitoringKelas;
          loadMonitoringKatalogKelas();
        })
        .withFailureHandler(handleBackendError)
        .deleteKelas(AppState.sessionToken, idKelas);
    }
    
    // ════════════════════════════════════════════════════════
    // BAGIAN 18: HELPER TAMPILAN HALAMAN
    // ════════════════════════════════════════════════════════
    
    function pageHeaderHtml(eyebrow, title, desc, actionHtml) {
      return `
        <div class="d-flex justify-content-between align-items-start flex-wrap gap-2 mb-3">
          <div>
            <div class="page-eyebrow">${escapeHtml(eyebrow)}</div>
            <div class="page-title">${title}</div>
            <div class="page-desc">${escapeHtml(desc)}</div>
          </div>
          <div>${actionHtml || ''}</div>
        </div>`;
    }
