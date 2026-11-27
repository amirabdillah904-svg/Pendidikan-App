# Dept. Pendidikan — YPM Al-Rifa'ie 2 (Android App)

Aplikasi Android untuk PWA **Departemen Pendidikan - YPM Al-Rifa'ie 2** yang dibundel lokal (`app/src/main/assets/www/`) dengan dukungan **Offline-First & Google Sheet Auto-Sync** (Room Database lokal, antrean sinkronisasi otomatis saat koneksi stabil, dan notifikasi HP real-time), Photo Picker, ekspor PDF/CSV, cetak dokumen, WhatsApp, sinkronisasi mode gelap, navigasi tombol kembali, serta workflow **GitHub Actions** untuk build APK/AAB otomatis.

Kode backend Google Apps Script untuk sinkronisasi offline batch & anti-duplikat (`SyncLog`) tersedia di `backend/appscript_offline_sync.gs`.

Versi **PWA mandiri siap hosting** (Netlify, Vercel, GitHub Pages, Cloudflare Pages) tersedia di folder khusus **`pwa/`** (bisa disinkronkan kapan saja dengan `bash scripts/sync-pwa.sh`).

## GitHub Actions Workflow

File workflow berada di `.github/workflows/android-build.yml` dan otomatis berjalan pada:
- Setiap `push` ke branch `main` atau `master`
- Setiap `pull_request` ke `main` atau `master`
- Push tag versi (`v*`, misalnya `v1.0.0`) untuk membuat **GitHub Release** otomatis
- Pemicu manual melalui tab **Actions → Build Android APK & Release → Run workflow**

## Menambahkan Secrets Signing Release di GitHub

> **Penting:** Demi keamanan, jangan pernah menuliskan password atau isi file `.jks` langsung ke dalam kode atau file workflow. Simpan hanya di **GitHub Repository Secrets**.

1. **Buat keystore lokal** (jika belum punya) dengan menjalankan:
   ```bash
   bash scripts/generate-release-keystore.sh
   ```
   Script ini menghasilkan file `my-upload-key.jks` (alias `upload`) dan `keystore.base64.txt` (keduanya otomatis diabaikan oleh `.gitignore`).
2. Jika Anda sudah memiliki file `.jks` dengan alias `upload`, ubah ke Base64 satu baris:
   ```bash
   base64 -w 0 my-upload-key.jks > keystore.base64.txt
   ```
3. Buka repositori GitHub Anda → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**, lalu tambahkan 3 secret berikut:
   - `KEYSTORE_BASE64` → tempel seluruh isi `keystore.base64.txt`
   - `STORE_PASSWORD` → kata sandi keystore `.jks` Anda
   - `KEY_PASSWORD` → kata sandi key untuk alias `upload`
4. Setelah ke-3 secret ditambahkan, setiap `push` ke `main`/`master` atau `Run workflow` akan otomatis memvalidasi keystore dan menghasilkan artefak **`DeptPendidikan-artifacts`** (`DeptPendidikan.apk` dan `DeptPendidikan.aab`).
