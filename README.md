# Fyy Stream (Wibuflix)

Fyy Stream adalah aplikasi *streaming* anime tanpa iklan yang mengambil data (*scraping*) langsung dari situs Samehadaku. Proyek ini terdiri dari dua bagian utama: **Backend** (Node.js/Express) untuk melakukan ekstraksi dan *proxy* video, serta **Frontend** (React Native/Expo) untuk memutar video dengan antarmuka yang bersih dan mulus.

## ✨ Fitur Utama

### 🔧 Backend (Scraper, Proxy & Cloud Storage)
- **Cloudflare Bypass**: Menggunakan *Puppeteer* dan *Cheerio* untuk menembus proteksi Cloudflare Samehadaku secara otomatis.
- **Azure Blob Storage & Prefetching**: Mengalirkan video dari *hoster* langsung ke Azure Blob Storage untuk kecepatan maksimal. Mendukung sistem *Background Prefetching* (N+1 & N+2) sehingga episode selanjutnya sudah siap ditonton tanpa *buffering*.
- **Smart Proxying & Fallback**: Memanipulasi *User-Agent* untuk melewati pemblokiran. Jika video sedang dalam proses *UPLOADING* ke Azure, sistem otomatis beralih ke *Proxy Stream Instan*, memungkinkan pengguna menonton tanpa menunggu *upload* selesai!
- **Unified Metadata (TMDB)**: Otomatis memperkaya (*enrich*) data anime & tokusatsu (poster HD, sinopsis, skor) dari server TMDB menggunakan *Background Workers*.
- **Multi-Source Scraping**: Menarik data tak hanya dari Samehadaku, namun juga menyedot basis data besar dari Otakudesu dan Neosatsu secara otomatis menggunakan sistem *Cron Job*.

### 📱 Frontend (Mobile App)
- **Native & Webview Player**: Menggunakan `expo-video` untuk memutar video secara langsung (*native*) tanpa iklan. Jika *server* tidak bisa diekstrak (seperti Mega, Bstation, Bilibili), pemutar otomatis beralih ke mode *Webview*.
- **Premium UX & Soft Navigation**: Memanfaatkan `InteractionManager` dan *Soft Route Params* agar perpindahan antar-episode atau dari Beranda sangat mulus, secepat kilat (0ms delay), tanpa *lag/stutter* memori.
- **Watch History & Progress Tracking**: Riwayat tontonan cerdas yang tidak akan pernah dobel (menggunakan sistem penumpukan deduplikasi *URL* otomatis). Aplikasi selalu mengingat detak (*progress*) detik terakhir video Anda.
- **Smart Navigation**: 
  - *Double-tap* di sisi layar untuk mempercepat mundur/maju 10 detik.
  - Tombol lewati *Opening/Ending* (OP/ED).
  - Peralihan episode yang persisten tanpa merusak mode layar penuh (*fullscreen*).
- **Audio Leak Prevention**: Penghancuran memori *Webview* dengan injeksi JavaScript untuk mencegah *bug* suara video tetap berjalan di latar belakang.

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
├── /src/                      # Folder utama Backend (Clean Architecture)
│   ├── /api/                  # Wrappers untuk API eksternal (Jikan, dll)
│   ├── /config/               # Konfigurasi MongoDB dan Mongoose
│   ├── /controllers/          # Logika HTTP (Katalog, Episode, Hot, dll)
│   ├── /jobs/                 # Skrip Scheduler (Cron)
│   ├── /middlewares/          # Middleware Express (ErrorHandler, dll)
│   ├── /models/               # Schema Mongoose (Anime, Video, dll)
│   ├── /puppeteer/            # Manajemen Pool Browser Puppeteer
│   ├── /routes/               # Definisi endpoint (Express Router)
│   ├── /services/             # Logika bisnis terpisah
│   │   ├── /extractors/       # Script web scraper & video extractors
│   │   └── /metadata/         # Layanan enrichment data (TMDB)
│   ├── /sync/                 # Logika background worker & database syncer
│   ├── /utils/                # Helper Azure Uploader & Queue Manager
│   └── server.js              # Entry point server Express minimalis
│
├── /FYYStreamApp/             # Folder utama Frontend (React Native Expo)
│   ├── /app/                  # Layar utama (Home, Player, Anime Details)
│   ├── /components/           # Komponen UI (PlayerNativeControls, CatalogView)
│   ├── /store/                # Manajemen State (Zustand)
│   └── ...
│
└── package.json               # Konfigurasi dependensi backend
```

---

## 📝 Catatan Penting
- **Batasan Pixeldrain/Nakama**: Server Pixeldrain sangat sensitif terhadap *User-Agent*. Semua *streaming* dari Nakama kini melewati sistem *proxy* backend dengan penyamaran *User-Agent* agar video bisa dimuat oleh *Native Player* Android.
- **Mode Layar Penuh (Fullscreen)**: Orientasi layar otomatis dikunci ke mode *Landscape* ketika menekan tombol layar penuh dan kembali ke *Portrait* ketika aplikasi di-kembalikan.

*Dibuat untuk pembelajaran web scraping dan pengembangan React Native.*
