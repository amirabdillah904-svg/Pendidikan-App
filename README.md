# Dept. Pendidikan — YPM Al-Rifa'ie 2 (Android App)

Aplikasi Android untuk PWA **Departemen Pendidikan - YPM Al-Rifa'ie 2** yang sudah dibundel secara lokal (`app/src/main/assets/www/`) lengkap dengan integrasi native Android (Photo Picker, ekspor PDF/CSV, cetak dokumen, WhatsApp, tema terang/gelap, dan navigasi tombol kembali) serta workflow **GitHub Actions** untuk build APK/AAB otomatis.

## GitHub Actions Workflow

File workflow berada di `.github/workflows/android-build.yml` dan otomatis berjalan pada:
- Setiap `push` ke branch `main` atau `master`
- Setiap `pull_request` ke `main` atau `master`
- Push tag versi (`v*`, misalnya `v1.0.0`) untuk membuat **GitHub Release** otomatis
- Pemicu manual melalui tab **Actions → Build Android APK & Release → Run workflow**

### Mengunduh APK dari GitHub Actions
1. Push proyek ini ke repositori GitHub Anda.
2. Buka tab **Actions** di repositori GitHub.
3. Pilih run terbaru dari **Build Android APK & Release**.
4. Unduh file **`DeptPendidikan-debug-apk`** pada bagian **Artifacts**.

### Opsional: Build Signed Release APK & AAB
Untuk mengaktifkan build rilis bertanda tangan (`.apk` dan `.aab`), tambahkan 3 **Repository Secrets** di GitHub (*Settings → Secrets and variables → Actions*):
- `KEYSTORE_BASE64`: isi file keystore `.jks` (alias `upload`) dalam format base64
- `STORE_PASSWORD`: kata sandi keystore
- `KEY_PASSWORD`: kata sandi key alias `upload`
