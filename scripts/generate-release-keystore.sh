#!/usr/bin/env bash
set -euo pipefail

KEYSTORE_FILE="${1:-my-upload-key.jks}"
KEY_ALIAS="upload"

if [ -f "$KEYSTORE_FILE" ]; then
  echo "File $KEYSTORE_FILE sudah ada. Hapus dulu atau tentukan nama file lain."
  exit 1
fi

read -r -s -p "Masukkan STORE_PASSWORD (minimal 6 karakter): " STORE_PASSWORD
echo ""
read -r -s -p "Masukkan KEY_PASSWORD untuk alias 'upload' (tekan Enter jika sama): " KEY_PASSWORD
echo ""
KEY_PASSWORD="${KEY_PASSWORD:-$STORE_PASSWORD}"

keytool -genkeypair -v \
  -keystore "$KEYSTORE_FILE" \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000 \
  -alias "$KEY_ALIAS" \
  -storepass "$STORE_PASSWORD" \
  -keypass "$KEY_PASSWORD" \
  -dname "CN=Departemen Pendidikan, OU=YPM Al-Rifaie 2, O=YPM Al-Rifaie 2, L=Malang, ST=Jawa Timur, C=ID"

BASE64_OUT="keystore.base64.txt"
base64 -w 0 "$KEYSTORE_FILE" > "$BASE64_OUT" 2>/dev/null || base64 "$KEYSTORE_FILE" | tr -d '\n' > "$BASE64_OUT"

echo ""
echo "Berhasil dibuat!"
echo "- File keystore : $KEYSTORE_FILE (JANGAN commit ke Git!)"
echo "- Base64 output : $BASE64_OUT (salin isinya ke GitHub Secret KEYSTORE_BASE64)"
echo ""
echo "Tambahkan 3 Repository Secrets berikut di GitHub (Settings -> Secrets and variables -> Actions):"
echo "  1. KEYSTORE_BASE64 : isi file $BASE64_OUT"
echo "  2. STORE_PASSWORD  : kata sandi keystore yang baru Anda masukkan"
echo "  3. KEY_PASSWORD    : kata sandi key alias 'upload' yang baru Anda masukkan"
