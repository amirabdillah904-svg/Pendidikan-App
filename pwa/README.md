# Folder Khusus PWA — Dept. Pendidikan YPM Al-Rifa'ie 2

Folder `pwa/` ini berisi versi **Progressive Web App (PWA)** siap pakai dan siap hosting (GitHub Pages, Netlify, Vercel, Cloudflare Pages, atau hosting statis lainnya) yang disinkronkan dengan bundel web di dalam aplikasi Android (`app/src/main/assets/www/`).

## Isi Folder
- `index.html` — Halaman utama aplikasi PWA + jembatan koneksi Google Apps Script.
- `manifest.json` — Konfigurasi instalasi PWA (*Add to Home Screen* di Android/iOS/Desktop).
- `sw.js` — *Service Worker* untuk cache aset dan dukungan akses cepat/offline.
- `admin-settings-module.js`, `nfc-qr-module.js`, `qr-lib.js`, `smart-features-module.js` — Modul fitur aplikasi.
- `icon-192.png`, `icon-512.png`, `login-*.jpg`, `char-*.jpg` — Ikon PWA dan aset ilustrasi.

## Cara Hosting Cepat
1. **Netlify / Vercel / Cloudflare Pages**: Arahkan *Publish / Root Directory* ke folder `pwa`.
2. **GitHub Pages**: Pilih folder `pwa` sebagai sumber publikasi (atau unggah isi folder `pwa` ke branch `gh-pages`).
3. **Coba Lokal**: Jalankan `npx serve pwa` atau `python3 -m http.server 8080 --directory pwa`.

## Sinkronisasi Ulang dari Aplikasi Android
Jika ada pembaruan di `app/src/main/assets/www/`, jalankan:
```bash
bash scripts/sync-pwa.sh
```
