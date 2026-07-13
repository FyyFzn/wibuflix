# 🌊 Wibuflix Backend — Complete Architecture & Task Flow

Dokumentasi ini memetakan **Task Flow (Alur Kerja)** end-to-end dari ekosistem **Wibuflix Backend (`samehadaku-scraper`)** yang telah direstrukturisasi ke dalam **Clean Layered Architecture (1 File = 1 Job / Single Responsibility Principle)**.

---

## 🏛️ Arsitektur Sistem & Lapisan Tanggung Jawab

Setiap modul di dalam aplikasi ini memiliki tepat satu tanggung jawab spesifik tanpa tumpah tindih (Zero Redundancy / Backward Compatibility Clutter):

| Lapisan (Layer) | Direktori / Modul | Tanggung Jawab Utama (Single Responsibility) |
| :--- | :--- | :--- |
| **1. Routers** | `src/routes/*.js` | Murni mendefinisikan *endpoint* HTTP/Express dan mengarahkan ke Controller yang tepat. |
| **2. Controllers** | `src/controllers/*.js` | Validasi input (*request query/params*), memanggil Service domain, dan memformat respons HTTP (serta validasi kontrak API). |
| **3. Domain Services** | `src/services/*.js` | Logika bisnis utama, orkestrasi multi-provider (`animeOrchestrator`), ranking server (`streamRankingService`), dan *unified extraction engine* (`prefetchService`). |
| **4. Scrapers & Extractor** | `src/services/scrapers/`, `extractors/` | Scraping HTML/JSON dari situs sumber eksternal (Samehadaku, Kuronime, Neosatsu, Otakudesu) dan ekstraksi tautan video (*stream link*). |
| **5. Storage & Stream** | `src/services/stream/*.js` | *Manajemen streaming*: Azure Blob Storage (`blobStorageService`), *progress state cache* (`uploadProgressService`), dan konversi HLS FFmpeg (`ffmpegStreamService`). |
| **6. Utilities & Jobs** | `src/utils/`, `src/jobs/` | *Cross-cutting helper*: antrean latar belakang (`queueManager`), penjadwal (`scheduler`), normalisasi teks (`stringUtils`), dan validasi kontrak (`contractValidator`). |

---

## 🔄 Task Flow 1: Metadata & Catalog Discovery (Thin Client V2)

Alur ini terjadi ketika aplikasi klien (React Native / Thin Client) meminta daftar episode anime yang diperkaya dari berbagai provider.

```mermaid
sequenceDiagram
    autonumber
    actor Client as Client App (V2)
    participant Route as v2Router (/api/v2/episodes)
    participant Ctrl as v2Controller
    participant Orch as animeOrchestrator
    participant Scrapers as Multi-Provider Scrapers
    participant DB as MongoDB / Cache

    Client->>Route: GET /api/v2/anime/:slug/episodes?refresh=false
    Route->>Ctrl: getV2Episodes(req, res)
    Ctrl->>Orch: getUnifiedAnimeEpisodes({ slug, forceRefresh })
    Orch->>DB: Cek Cache MongoDB (AnimeMetadata)
    
    alt Cache Tersedia & Valid (Tidak forceRefresh)
        DB-->>Orch: Return Cached Metadata
    else Cache Kosong atau Expired / forceRefresh=true
        Orch->>Scrapers: Scrape Paralel (Samehadaku, Kuronime, Otakudesu)
        Scrapers-->>Orch: Return Raw Episodes List
        Orch->>Orch: Deduplikasi & Normalisasi Slug (Canonical ID)
        Orch->>DB: Simpan / Update Cache ke MongoDB
    end

    Orch-->>Ctrl: Return Unified Catalog Data
    Ctrl->>Ctrl: assertAndRespondContract() [Validasi Schema HTTP 200/502]
    Ctrl-->>Client: JSON Response (Daftar Episode Bersatu)
```

---

## 🚀 Task Flow 2: Unified Video Extraction & Cloud CDN Streaming

Inilah **inti** dari pemutaran video (`Smart-Play` / `API V2 Stream`). Seluruh ekstraksi didelegasikan ke mesin tunggal `prefetchOneEpisode` untuk menjamin konsistensi antara permintaan pengguna langsung dan pekerjaan latar belakang.

```mermaid
sequenceDiagram
    autonumber
    actor Player as Video Player / Client
    participant Ctrl as v2StreamController / extractController
    participant Blob as blobStorageService
    participant Prefetch as prefetchService (prefetchOneEpisode)
    participant Rank as streamRankingService
    participant Ext as Video Extractor / Puppeteer
    participant FFmpeg as ffmpegStreamService

    Player->>Ctrl: GET /api/v2/stream?url=...&slug=...
    Ctrl->>Blob: checkUploadStatusWithFallback(seriesSlug, episodeSlug)
    
    alt Video Sudah Ada di Azure CDN ('READY')
        Blob-->>Ctrl: status: 'READY'
        Ctrl-->>Player: Return Azure Blob CDN HLS URL (playlist.m3u8)
    else Video Sedang Diunggah ('UPLOADING')
        Blob-->>Ctrl: status: 'UPLOADING'
        Ctrl-->>Player: Return Progress info / Polling Instruction
    else Belum Tersedia di Cloud CDN (status: null / FAILED)
        Ctrl->>Prefetch: prefetchOneEpisode(seriesSlug, url, 'player', ...)
        Note over Prefetch: Engine Ekstraksi Terpusat (Single Source of Truth)
        
        Prefetch->>Rank: findBestVideoSource(url, slugs)
        Rank->>Rank: Cek Blacklist URL & Provider (getProviderKey)
        Rank->>Ext: Scrape & Resolve Stream URL Terbaik (Sesuai Resolusi)
        Ext-->>Rank: Return Candidate URL (720p/1080p/360p)
        Rank-->>Prefetch: Best Video Link Terpilih
        
        Prefetch->>FFmpeg: uploadStream(bestUrl, seriesSlug, episodeSlug)
        Note over FFmpeg: Konversi HLS (playlist.m3u8) & Block Blob Upload ke Azure
        FFmpeg-->>Prefetch: Upload Selesai / Siap Diputar
        
        Prefetch-->>Ctrl: Ekstraksi & CDN Upload Sukses
        Ctrl-->>Player: Return Azure CDN HLS URL
    end
```

---

## 🛡️ Task Flow 3: Proactive Multi-Provider Failover (Error Handling)

Saat pengguna atau sistem mendeteksi video rusak (404 / 403 / proteksi Cloudflare / tanpa subtitle), sistem tidak mencoba *mirror* dari provider yang sama, melainkan **melakukan auto-switch ke provider alternatif**.

```mermaid
flowchart TD
    A[Player melaporkan error: POST /api/v2/stream/report-broken] --> B[v2StreamController / reportBrokenHandler]
    B --> C[getProviderKey: Identifikasi Provider yang Rusak]
    
    C --> D[blacklistEpisodeProvider: Masukkan Provider ke Blacklist Memory Cache 15 Menit]
    C --> E[checkUrlBlacklisted: Masukkan URL Spesifik ke Blacklist Cache]
    
    D & E --> F[Batalkan Upload FFmpeg yang Sedang Berjalan: cancelUpload & deleteBlobFromAzure]
    
    F --> G{Cari Provider Alternatif dari Metadata ep.urls}
    G -- "Ada URL Provider Lain yang Bersih (!checkUrlBlacklisted)" --> H[Kirim extractionUrl Baru ke prefetchOneEpisode]
    G -- "Tidak Ada Alternatif di ep.urls" --> I[Cek Candidates Scraping / Trigger Orchestrator Refresh]
    
    H & I --> J[Ekstraksi Ulang dari Provider Baru & Upload ke Azure CDN]
    J --> K[Player Menerima Stream Baru dari Server Alternatif]
```

---

## ⚙️ Task Flow 4: Background Queue & Prefetch Automation

Untuk menghemat kuota dan memastikan pemutaran instan (*zero buffer*), sistem secara otomatis mengantrekan download video episode berikutnya saat episode sedang ditonton atau melalui *Scheduler*.

```mermaid
sequenceDiagram
    autonumber
    actor Trigger as Player Window / Job Scheduler
    participant Queue as backgroundQueue (queueManager)
    participant DB as MongoDB (QueueTask Model)
    participant Worker as Concurrency Worker
    participant Prefetch as prefetchService (prefetchOneEpisode)

    Trigger->>Queue: add(episodeUrl, seriesUrl, seriesSlug, uniqueId)
    Queue->>DB: Simpan Task dengan Status 'QUEUED'
    Queue->>Queue: processQueue() [Batasi Maksimum 2 Concurrency]
    
    Queue->>Worker: Eksekusi Task Berikutnya
    Worker->>DB: Update Status Task -> 'UPLOADING'
    Worker->>Prefetch: prefetchOneEpisode(..., source='background')
    
    alt Ekstraksi & Upload Sukses
        Prefetch-->>Worker: Upload Selesai
        Worker->>DB: Update Status Task -> 'COMPLETED'
    else Ekstraksi Gagal / Timeout
        Prefetch-->>Worker: Error Caught
        Worker->>DB: Update Status Task -> 'FAILED' & Re-queue Jika Ada Retry
    end
    
    Note over Queue, Worker: Klien bisa cek real-time status melalui SSE: GET /api/queue/stream
```

---

## 📊 Matriks Status Upload & Siklus Hidup File (`uploadProgressService`)

Siklus hidup setiap berkas video di dalam sistem dikelola melalui *State Store* berbasis memori dan Azure Storage secara sinkron:

```
[ NULL / NOT STARTED ]
         │
         ▼ (Ekstraksi Dimulai via prefetchOneEpisode)
 [ UPLOADING / PROCESSING ] ───► progress: 0% -> 99% (Dilacak oleh getUploadProgress)
         │
         ├────────────────────────────────────────┬────────────────────────────────────────┐
         ▼ (Sukses Upload M3U8 & Segmen)          ▼ (Dibatalkan via cancelUpload)          ▼ (Gagal / Broken Stream)
     [ READY ]                             [ CANCELLED ]                            [ FAILED ]
 (Tersedia di Azure CDN)               (Dihapus dari Azure & Cache)             (Di-blacklist / Trigger Failover)
```
