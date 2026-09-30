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
const GAS_GET_ACTIONS = new Set([
  'checkSession', 'getAppUrl', 'getGuestCatalog', 'getKatalogSaya', 'getKelasSaya',
  'getKelasDetail', 'getVideoTutorialSaya', 'getSemuaVideoUntukDosen',
  'getLaporanAktivitasDosen', 'getTutorialKonten', 'getAdminDashboardData',
  'getAllUsers', 'getBankVideo', 'getLaporanGlobal', 'getKatalogSemuaDosen', 'getKelasSemuaDosen',
  'ping', 'getBootstrapData'
]);
// Sisanya (login, save*, delete*, create*, redeem, regenerate, toggle, record*)
// otomatis dikirim via POST — lihat gasCall().

// Nama parameter positional per action (urutan HARUS sama dengan signature
// fungsi backend di Kode.gs), supaya argumen posisional gaya
// google.script.run.xxx(a, b, c) bisa dikonversi otomatis jadi { a, b, c }.
const GAS_ACTION_PARAMS = {
  checkSession: ['token'],
  getAppUrl: [],
  ping: [],
  getBootstrapData: ['token'],
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
  getKatalogSemuaDosen: ['token'],
  getKelasSemuaDosen: ['token'],
  toggleKatalogLinkStatus: ['token', 'id'],
  doLogin: ['identifier', 'password'],
  loginWithGoogle: [],
  doLogout: ['token'],
  recordLinkClick: ['idLink', 'token'],
  saveKatalogLink: ['token', 'record'],
  deleteKatalogLink: ['token', 'id'],
  createKelas: ['token', 'namaKelas', 'jumlahMahasiswa'],
  updateKelas: ['token', 'idKelas', 'namaKelas', 'jumlahMahasiswa'],
  saveDistribusiKelas: ['token', 'idKelas', 'selectedLinkIds'],
  regenerateToken: ['token', 'idKelas'],
  deleteKelas: ['token', 'idKelas'],
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

// ════════════════════════════════════════════════════════
// LAPISAN TRANSPORT — cepat, tahan gangguan, konsisten
// ════════════════════════════════════════════════════════
// • Timeout          : request tidak akan menggantung selamanya.
// • Retry sekali     : khusus BACA (aman diulang) saat jaringan/server goyah.
//                      TULIS tidak pernah diulang otomatis (cegah data ganda).
// • Dedupe           : dua pemanggilan BACA identik yang berjalan bersamaan
//                      berbagi satu request.
// • Micro-cache 20 dt: klik bolak-balik antar menu tidak menembak server lagi.
//                      Dibersihkan otomatis setiap ada aksi TULIS.
// • Baca-setelah-tulis: pembacaan menunggu aksi tulis yang sedang berjalan
//                      selesai, dan diulang bila ada tulis di tengah jalan —
//                      sehingga data basi tidak pernah menimpa tampilan
//                      optimistik (item yang baru dihapus tidak "hidup lagi").
// • Indikator sinkron: class "is-syncing" di <body> (garis tipis di atas layar).
const GAS_MICROCACHE_TTL = 20000;
const GAS_MICROCACHE_SKIP = new Set(['checkSession', 'ping', 'getGuestCatalog']);
const GAS_READ_TIMEOUT = 30000;
const GAS_WRITE_TIMEOUT = 45000;

const gasMicro = new Map();     // url -> { t, json }
const gasInflight = new Map();  // url -> Promise<json>
const gasPendingWrites = new Set();
let gasEpoch = 0;               // naik setiap ada tulis dimulai / selesai
let gasBusy = 0;

function gasBusyDelta(d) {
  gasBusy = Math.max(0, gasBusy + d);
  if (document.body) document.body.classList.toggle('is-syncing', gasBusy > 0);
}

function gasWait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function gasFetchJson(url, init, timeoutMs, retryOnce) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    const e = new Error('offline'); e.userMessage = 'Anda sedang offline. Periksa koneksi internet Anda.'; throw e;
  }
  const attempts = retryOnce ? 2 : 1;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, Object.assign({}, init, { signal: ctrl.signal }));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await gasWait(700);
    } finally {
      clearTimeout(timer);
    }
  }
  const e = new Error(lastErr && lastErr.message);
  e.userMessage = (lastErr && lastErr.name === 'AbortError')
    ? 'Server terlalu lama merespons. Coba lagi sebentar lagi.'
    : 'Gagal terhubung ke server. Cek koneksi internet Anda atau URL backend di js/config.js.';
  throw e;
}

async function gasRead(action, payload, paramNames) {
  const qs = new URLSearchParams({ action });
  (paramNames || []).forEach(name => {
    const val = payload[name];
    if (val === undefined || val === null) return;
    qs.set(name, typeof val === 'object' ? JSON.stringify(val) : String(val));
  });
  const url = GAS_URL + '?' + qs.toString();
  const cacheable = !GAS_MICROCACHE_SKIP.has(action);

  if (cacheable) {
    const hit = gasMicro.get(url);
    if (hit && Date.now() - hit.t < GAS_MICROCACHE_TTL) return hit.json;
  }
  if (gasInflight.has(url)) return gasInflight.get(url);

  const p = (async () => {
    let json;
    for (let round = 0; round < 2; round++) {
      while (gasPendingWrites.size) await Promise.allSettled([...gasPendingWrites]);
      const epochAtStart = gasEpoch;
      json = await gasFetchJson(url, {}, GAS_READ_TIMEOUT, true);
      if (epochAtStart === gasEpoch) break; // tidak ada tulis di tengah jalan → hasil segar
    }
    if (cacheable && json && json.success) gasMicro.set(url, { t: Date.now(), json });
    return json;
  })();

  gasInflight.set(url, p);
  gasBusyDelta(1);
  try { return await p; }
  finally { gasInflight.delete(url); gasBusyDelta(-1); }
}

async function gasWrite(action, payload) {
  gasEpoch++;
  gasBusyDelta(1);
  const p = gasFetchJson(GAS_URL, {
    method: 'POST',
    // WAJIB text/plain — Content-Type: application/json memicu CORS
    // preflight (OPTIONS) yang tidak ditangani dengan baik oleh GAS.
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, data: payload })
  }, GAS_WRITE_TIMEOUT, false);
  gasPendingWrites.add(p);
  try { return await p; }
  finally {
    gasPendingWrites.delete(p);
    gasMicro.clear();   // apa pun hasilnya, data bacaan lama tak lagi dipercaya
    gasEpoch++;
    gasBusyDelta(-1);
  }
}

function gasCall(action, args, successHandler, failureHandler) {
  const paramNames = GAS_ACTION_PARAMS[action];
  if (!paramNames) {
    console.error('[api.js] Action tidak dikenal di GAS_ACTION_PARAMS:', action);
  }
  const payload = {};
  (paramNames || []).forEach((name, i) => { payload[name] = args[i]; });

  // Dijalankan sebagai microtask supaya kode pemanggil (app.js) tidak perlu
  // menunggu apa pun secara sinkron — persis perilaku google.script.run asli.
  queueMicrotask(async () => {
    let json;
    try {
      json = GAS_GET_ACTIONS.has(action)
        ? await gasRead(action, payload, paramNames)
        : await gasWrite(action, payload);
    } catch (err) {
      try { failureHandler({ message: (err && err.userMessage) || 'Gagal terhubung ke server.' }); }
      catch (e) { console.error('[api.js] failureHandler error:', e); }
      return;
    }
    // Error di kode tampilan (successHandler) dilaporkan ke console apa adanya,
    // TIDAK disamarkan sebagai "gagal terhubung".
    try { successHandler(json); }
    catch (e) { console.error('[api.js] successHandler error untuk', action, e); }
  });
}

// Pemanasan server (cold start Apps Script bisa 2–5 detik). Dipanggil saat
// halaman dibuka & berkala selama tab aktif. Hasilnya diabaikan.
function gasWarmup() {
  try { fetch(GAS_URL + '?action=ping').catch(() => {}); } catch (e) {}
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
