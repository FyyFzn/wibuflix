# Fyy Stream (Wibuflix)

Fyy Stream adalah aplikasi *streaming* anime tanpa iklan yang mengambil data (*scraping*) langsung dari situs Samehadaku. Proyek ini terdiri dari dua bagian utama: **Backend** (Node.js/Express) untuk melakukan ekstraksi dan *proxy* video, serta **Frontend** (React Native/Expo) untuk memutar video dengan antarmuka yang bersih dan mulus.

## ✨ Fitur Utama

### 🔧 Backend (Scraper & Proxy)
- **Cloudflare Bypass**: Menggunakan *Puppeteer* dan *Cheerio* untuk menembus proteksi Cloudflare Samehadaku secara otomatis.
- **Video Extractor**: Mengekstrak *direct link* video (.mp4/.m3u8) dari berbagai *server* seperti Vidhide, Krakenfiles, Filedon (Pucuk), Pixeldrain (Nakama), Blogger, dan lainnya.
- **Smart Proxying**: Menyembunyikan *User-Agent* asli (seperti *ExoPlayer* dari Android) ke *server* tujuan (seperti Pixeldrain dan Filedon) untuk menghindari pemblokiran *hotlinking* (Error 403/404).
- **Smart Caching & Metadata**: Menyimpan hasil *scraping* daftar episode sementara (RAM *caching*) untuk mempercepat pemuatan. Terintegrasi dengan Jikan API (MyAnimeList) untuk menambahkan skor dan genre pada anime.

### 📱 Frontend (Mobile App)
- **Native & Webview Player**: Menggunakan `expo-video` untuk memutar video secara langsung (*native*) tanpa iklan. Jika *server* tidak bisa diekstrak (seperti Mega, Bstation, Bilibili), pemutar akan otomatis beralih ke mode *Webview*.
- **Seamless Server Transition**: Transisi yang mulus saat berganti *server* atau resolusi video. Progres video yang ditonton akan disimpan dan dilanjutkan secara otomatis saat server diganti.
- **Smart Navigation**: 
  - *Double-tap* di sisi layar untuk mempercepat mundur/maju 10 detik.
  - Tombol lewati *Opening/Ending* (OP/ED).
  - Peralihan episode lancar tanpa keluar dari mode layar penuh (*fullscreen*).
- **Audio Leak Prevention**: Penghancuran memori *Webview* dengan injeksi JavaScript untuk mencegah *bug* di mana suara video tetap berjalan di latar belakang setelah mengganti server atau menutup pemutar.

---

## 🚀 Cara Menjalankan Proyek

### 1. Menjalankan Backend (Server)
Pastikan kamu telah menginstal Node.js dan berada di direktori *root* (tempat `server.js` berada).

```bash
# Instal dependensi (Puppeteer, Express, Cheerio, Axios, dll)
npm install

# Jalankan server
node src/server.js
# atau gunakan nodemon untuk auto-restart saat pengembangan
npm run dev
```
*Backend akan berjalan secara bawaan di `http://0.0.0.0:3000` (atau port yang diatur di `.env`).*

### 2. Menjalankan Frontend (Aplikasi Mobile)
Masuk ke folder frontend dan jalankan menggunakan Expo CLI.

```bash
cd FYYStreamApp

# Instal dependensi React Native/Expo
npm install

# Jalankan aplikasi (untuk Emulator atau perangkat fisik via Expo Go)
npx expo start
```
*Pastikan konfigurasi URL backend di dalam aplikasi frontend sudah mengarah ke IP lokal komputermu (misalnya `http://192.168.x.x:3000`).*

---

## 🛠️ Struktur Direktori

```text
/samehadaku-scraper/
│
├── /src/                 # Folder utama Backend
│   ├── /scraper/         # Kumpulan logika Puppeteer/Cheerio (extractor.js, dll)
│   └── server.js         # Entry point server Express & Proxy API
│
├── /FYYStreamApp/        # Folder utama Frontend (React Native Expo)
│   ├── /app/             # Layar utama (Home, Player, Anime Details)
│   ├── /components/      # Komponen terpisah (PlayerNativeControls, PlayerWebView)
│   ├── /styles/          # Konfigurasi Tema (Colors) dan StyleSheet
│   └── ...
│
└── package.json          # Konfigurasi dependensi backend
```

---

## 📝 Catatan Penting
- **Batasan Pixeldrain/Nakama**: Server Pixeldrain sangat sensitif terhadap *User-Agent*. Semua *streaming* dari Nakama kini melewati sistem *proxy* backend dengan penyamaran *User-Agent* agar video bisa dimuat oleh *Native Player* Android.
- **Mode Layar Penuh (Fullscreen)**: Orientasi layar otomatis dikunci ke mode *Landscape* ketika menekan tombol layar penuh dan kembali ke *Portrait* ketika aplikasi di-kembalikan.

*Dibuat untuk pembelajaran web scraping dan pengembangan React Native.*
