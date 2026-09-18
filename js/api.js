/**
 * ============================================================
 * API BRIDGE — google.script.run  →  fetch() REST (GAS-PRO-API)
 * ============================================================
 * File ini membuat objek global `google.script.run` palsu yang API-nya
 * IDENTIK dengan versi asli Apps Script:
 *
 *   google.script.run
 *     .withSuccessHandler(fn)
 *     .withFailureHandler(fn)
 *     .namaFungsi(arg1, arg2, ...)
 *
 * Tujuannya: app.js (hasil migrasi dari JavaScript.html) TIDAK PERLU
 * diubah satu baris pun di titik-titik pemanggilannya — hanya lapisan
 * transportnya yang diganti dari google.script.run/HtmlService menjadi
 * fetch() JSON ke Web App Apps Script (doGet/doPost).
 *
 * Tidak ada google.script.run asli, tidak ada iframe, tidak ada
 * HtmlService di seluruh proyek ini.
 * ============================================================
 */

// Action yang dibaca via GET (read-only, tanpa efek samping di server)
// CATATAN: doLogin & doLogout juga dikirim via GET untuk menghindari masalah
// redirect 302 CORS yang terjadi saat fetch() POST ke GAS dari origin eksternal
// (GitHub Pages). GAS me-redirect semua POST ke URL baru; browser memblokir
// redirect itu karena CORS sehingga fetch() tidak pernah resolve → login hang
// tanpa memanggil successHandler maupun failureHandler. GET tidak mengalami
// masalah ini karena GAS mengembalikan respons langsung tanpa redirect.
const GAS_GET_ACTIONS = new Set([
  'checkSession', 'getAppUrl', 'getGuestCatalog', 'getKatalogSaya', 'getKelasSaya',
  'getKelasDetail', 'getVideoTutorialSaya', 'getSemuaVideoUntukDosen',
  'getLaporanAktivitasDosen', 'getTutorialKonten', 'getAdminDashboardData',
  'getAllUsers', 'getBankVideo', 'getLaporanGlobal',
  // Write actions kecil yang amannya via GET (tidak ada body besar):
  'doLogin', 'doLogout', 'recordLinkClick', 'recordVideoView',
  'toggleVideoStatus', 'redeemVideoCode', 'generateKodeRedeem', 'regenerateToken'
]);
// Action besar (ada body/record object) tetap via POST — lihat gasCall().
// POST requests menggunakan redirect:'follow' + mode:'cors' untuk menangani
// redirect 302 GAS secara otomatis.

// Nama parameter positional per action (urutan HARUS sama dengan signature
// fungsi backend di Kode.gs), supaya argumen posisional gaya
// google.script.run.xxx(a, b, c) bisa dikonversi otomatis jadi { a, b, c }.
const GAS_ACTION_PARAMS = {
  checkSession: ['token'],
  getAppUrl: [],
  getGuestCatalog: ['token'],
  getKatalogSaya: ['token'],
  getKelasSaya: ['token'],
  getKelasDetail: ['token', 'idKelas'],
  getVideoTutorialSaya: ['token'],
  getSemuaVideoUntukDosen: ['token'],
  getLaporanAktivitasDosen: ['token', 'periodeHari'],
  getTutorialKonten: ['token'],
  getAdminDashboardData: ['token'],
  getAllUsers: ['token'],
  getBankVideo: ['token'],
  getLaporanGlobal: ['token', 'filters'],
  doLogin: ['identifier', 'password'],
  loginWithGoogle: [],
  doLogout: ['token'],
  recordLinkClick: ['idLink', 'token'],
  saveKatalogLink: ['token', 'record'],
  deleteKatalogLink: ['token', 'id'],
  createKelas: ['token', 'namaKelas', 'jumlahMahasiswa'],
  saveDistribusiKelas: ['token', 'idKelas', 'selectedLinkIds'],
  regenerateToken: ['token', 'idKelas'],
  redeemVideoCode: ['token', 'kode'],
  recordVideoView: ['token', 'idVideo'],
  saveTutorialKonten: ['token', 'record'],
  deleteTutorialKonten: ['token', 'id'],
  saveUser: ['token', 'record'],
  deleteUser: ['token', 'id'],
  saveBankVideo: ['token', 'record'],
  toggleVideoStatus: ['token', 'id'],
  generateKodeRedeem: ['token', 'idVideo']
};

function gasCall(action, args, successHandler, failureHandler) {
  const paramNames = GAS_ACTION_PARAMS[action];
  if (!paramNames) {
    console.error('[api.js] Action tidak dikenal di GAS_ACTION_PARAMS:', action);
  }
  const payload = {};
  (paramNames || []).forEach((name, i) => { payload[name] = args[i]; });

  // Fetch dijalankan sebagai microtask supaya kode pemanggil (app.js) tidak
  // perlu menunggu apa pun secara sinkron — persis perilaku google.script.run asli.
  queueMicrotask(async () => {
    try {
      let res;
      if (GAS_GET_ACTIONS.has(action)) {
        // GET: GAS mengembalikan JSON langsung tanpa redirect → aman untuk CORS
        const qs = new URLSearchParams({ action });
        (paramNames || []).forEach(name => {
          const val = payload[name];
          if (val === undefined || val === null) return;
          qs.set(name, typeof val === 'object' ? JSON.stringify(val) : String(val));
        });
        res = await fetch(GAS_URL + '?' + qs.toString(), { redirect: 'follow' });
      } else {
        // POST: WAJIB text/plain (bukan application/json) supaya tidak memicu
        // preflight OPTIONS. GAS akan redirect 302 → redirect:'follow' memastikan
        // fetch() mengikuti redirect dan tidak hang.
        res = await fetch(GAS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          redirect: 'follow',
          body: JSON.stringify({ action, data: payload })
        });
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      successHandler(json);
    } catch (err) {
      failureHandler({ message: 'Gagal terhubung ke server. Cek koneksi internet Anda atau URL backend di js/config.js.' });
    }
  });
}

// Objek "pembuka rantai" — HANYA withSuccessHandler & withFailureHandler yang
// jadi milik objek ini sendiri. Nama aksi apa pun (doLogin, saveKatalogLink,
// dst.) ditangkap oleh Proxy di bawah sebagai properti LAIN yang tidak
// dikenal, sehingga tidak pernah tertukar dengan kedua method di atas —
// inilah bug yang membuat versi sebelumnya gagal ("...withSuccessHandler
// is not a function" / "doLogin is not a function").
function makeRunChain(successHandler, failureHandler) {
  const base = {
    withSuccessHandler(fn) { return makeRunChain(fn, failureHandler); },
    withFailureHandler(fn) { return makeRunChain(successHandler, fn); }
  };
  return new Proxy(base, {
    get(target, prop) {
      if (Object.prototype.hasOwnProperty.call(target, prop)) return target[prop];
      // prop bukan withSuccessHandler/withFailureHandler → ini nama aksi
      return (...args) => gasCall(prop, args, successHandler, failureHandler);
    }
  });
}

// Proxy yang meniru google.script.run — dipanggil sebagai
// google.script.run.namaFungsi(arg1, arg2, ...), atau
// google.script.run.withSuccessHandler(fn).withFailureHandler(fn).namaFungsi(...),
// sama persis seperti pada versi Apps Script HtmlService asli.
window.google = {
  script: {
    // Handler default no-op untuk pemanggilan "fire & forget" tanpa
    // .withSuccessHandler()/.withFailureHandler() sama sekali.
    run: makeRunChain(() => {}, () => {})
  }
};