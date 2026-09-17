# 📋 PANDUAN INSTALASI — Portal EduMedia (Arsitektur GAS-PRO-API)

Aplikasi ini sekarang terdiri dari **2 bagian terpisah**:

| Bagian | Isi | Di-deploy ke |
|---|---|---|
| **Backend** | `Kode.gs` — REST API JSON murni | Google Apps Script |
| **Frontend** | `index.html`, `css/`, `js/` | GitHub Pages |

Backend **tidak lagi menyajikan halaman** — ia hanya menerima request dan membalas JSON. Frontend yang menampilkan tampilan dan memanggil backend lewat `fetch()`.

---

## BAGIAN 1 — Deploy Backend (Google Apps Script)

1. Buka [script.google.com](https://script.google.com) → **Proyek Baru**.
2. Hapus isi `Code.gs` bawaan, ganti nama file menjadi **Kode**, lalu tempel seluruh isi `Kode.gs` yang diberikan terpisah di chat.
3. Jalankan `setupAppEnvironment` — **HANYA jika ini instalasi baru** (belum pernah punya Spreadsheet `DB_PortalEduMedia`):
   - Dropdown fungsi di toolbar → pilih **setupAppEnvironment** → klik ▶ **Run**
   - Klik **Review permissions** → izinkan akses Drive & Sheets
   - Buka **Execution Log** — pastikan semua ✅ muncul
   - ⚠️ **Jangan** jalankan lebih dari sekali (folder & sheet akan terduplikasi)
   - **Kalau ini migrasi dari versi lama yang sudah punya data** (sudah ada Spreadsheet `DB_PortalEduMedia` berisi Users/Katalog/Kelas dsb.) — **lewati langkah ini sepenuhnya**. Data lama Anda tetap dipakai apa adanya.
4. **Deploy** → **New deployment** → ikon gerigi → pilih tipe **Web app**
   - **Execute as:** Me
   - **Who has access:** Anyone
   - Klik **Deploy** → salin **URL** yang diakhiri `/exec`
5. Simpan URL itu — dipakai di langkah berikutnya.

> 🔁 **Kalau backend sudah pernah dideploy sebelumnya** (versi lama), buat **New deployment** baru (bukan edit yang lama) supaya `doGet`/`doPost` versi REST API ini yang aktif, lalu ganti URL di frontend dengan URL deployment baru.

---

## BAGIAN 2 — Konfigurasi Frontend

1. Ekstrak ZIP frontend yang diberikan.
2. Buka `js/config.js`, ganti baris:
   ```js
   const GAS_URL = 'PASTE_URL_/exec_DARI_APPS_SCRIPT_DI_SINI';
   ```
   dengan URL `/exec` dari Bagian 1 langkah 4. Simpan.
3. **Jangan** ubah `js/api.js` — file itu jembatan teknis, tidak perlu disentuh.

---

## BAGIAN 3 — Deploy Frontend ke GitHub Pages

Folder yang sudah diekstrak (isinya `index.html`, `css/`, `js/`, `README.md`) **adalah** folder yang nanti di-`git init` — tidak ada folder pembungkus di dalamnya.

Ringkasan tahapannya:
1. Install Git (kalau belum ada) & buat akun GitHub.
2. Buat repository baru di GitHub (**Public**, tanpa centang README/.gitignore).
3. Dari terminal, masuk ke folder hasil ekstraksi ZIP ini, lalu:
   ```bash
   git init
   git add .
   git commit -m "Upload pertama"
   git branch -M main
   git remote add origin https://github.com/USERNAME/NAMA-REPO.git
   git push -u origin main
   ```
4. Di GitHub: **Settings → Pages** → Source: *Deploy from a branch* → Branch: **main** / **(root)** → **Save**.
5. Tunggu 1–2 menit, buka `https://USERNAME.github.io/NAMA-REPO/`.

**Ini bagian yang paling sering meleset bagi yang belum pernah pakai Git** — kalau Anda ingin dipandu langkah demi langkah (termasuk soal Personal Access Token untuk login saat `git push`), tinggal bilang saja di chat dan akan dipandu satu perintah demi satu perintah sambil mengecek hasilnya.

---

## BAGIAN 4 — Uji Coba

1. Buka URL GitHub Pages Anda.
2. Coba login pakai NIDN/Email + kata sandi Dosen/Admin yang sudah ada.
3. Buka **DevTools browser (F12) → tab Network** — pastikan request ke `.../exec?action=...` berstatus 200 dan tidak ada error CORS di tab **Console**.
4. Coba buka satu link kelas tamu (`?token=...`) di tab baru — pastikan katalog tamu tampil tanpa perlu login.

## Catatan Penting

- **Login dengan Google** kemungkinan besar tidak berfungsi lagi setelah migrasi ini, karena frontend & backend kini di domain (origin) yang berbeda — browser tidak lagi otomatis membawa sesi Google saat `fetch()` lintas origin. Gunakan login NIDN/Email + kata sandi sebagai jalur utama.
- Kalau situs tampil tapi data tidak muncul / muncul pesan "Gagal terhubung ke server" → cek lagi `GAS_URL` di `js/config.js`, dan pastikan deployment Apps Script sudah **Anyone** access.
- Setiap kali `Kode.gs` diedit di Apps Script, buat **New deployment** lagi (bukan sekadar Save) supaya perubahan benar-benar aktif di URL `/exec`.
