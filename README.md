# Portal EduMedia — Frontend

Frontend statis (HTML/CSS/JS vanilla) untuk Portal EduMedia, LMS media pembelajaran interaktif.

Arsitektur: **GAS-PRO-API** — frontend ini di-hosting terpisah (GitHub Pages) dan berkomunikasi dengan backend Google Apps Script murni sebagai REST API JSON (`fetch()`), tanpa `google.script.run`, tanpa iframe, tanpa `HtmlService`.

## Struktur

```
index.html          ← halaman utama (root — WAJIB tetap di sini untuk GitHub Pages)
css/
  └── style.css      ← seluruh styling
js/
  ├── config.js      ← SATU-SATUNYA file yang perlu diisi: GAS_URL
  ├── api.js          ← jembatan google.script.run → fetch() REST (jangan diedit)
  └── app.js          ← seluruh logika aplikasi (SPA, render, form, dst.)
```

## Setup cepat

1. Deploy backend `Kode.gs` di Google Apps Script (lihat `PANDUAN-INSTALASI.md`), salin URL `/exec`.
2. Isi URL tersebut ke `js/config.js` → `GAS_URL`.
3. Push folder ini (persis strukturnya) ke GitHub, aktifkan GitHub Pages dari branch `main` / root.

Detail lengkap ada di `PANDUAN-INSTALASI.md`.

## Catatan

- Backend (`Kode.gs`) **tidak** ada di folder ini secara sengaja — file itu untuk Apps Script, bukan untuk GitHub Pages.
- Login dengan akun Google (`loginWithGoogle`) kemungkinan besar tidak berfungsi lagi pasca-migrasi ini, karena frontend & backend kini berada di origin yang berbeda. Gunakan login NIDN/Email + kata sandi.
