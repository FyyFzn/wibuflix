import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

// Fix __dirname untuk ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import modul
import connectDB from './src/config/db.js';
import Anime from './src/models/Anime.js';
import { runSync } from './src/sync/anime_sync.js';
import { syncOtakudesu } from './src/sync/otaku_sync.js';
import { syncNeosatsu } from './src/sync/neosatsu_sync.js';
import { syncUnified } from './src/sync/unified_sync.js';
import { syncKuronime } from './src/sync/kuronime_sync.js';
import { initPagePool, getBrowser } from './src/puppeteer/pool.js';

async function rebuildDatabase() {
    console.log("=====================================================");
    console.log("🚀 MEMULAI REBUILD DATABASE WIBUFLIX (CLEAN INSTALL)");
    console.log("=====================================================\n");
    
    global.forceLog = console.log; // Pastikan logging menyala di terminal
    
    // 1. Hubungkan ke Database
    console.log("[1/6] Menghubungkan ke MongoDB...");
    await connectDB();
    
    // 2. Inisialisasi Puppeteer Pool (wajib untuk membongkar Cloudflare Samehadaku)
    console.log("\n[2/6] Menginisialisasi Puppeteer Pool (Bypass Cloudflare)...");
    await initPagePool();
    
    // 3. Hapus semua data Anime dari akar
    console.log("\n[3/6] Menghapus seluruh data katalog lama dari MongoDB...");
    const deleteResult = await Anime.deleteMany({});
    console.log(`✅ Data berhasil dihanguskan! (${deleteResult.deletedCount} dokumen terhapus)`);
    
    // 4. Sinkronisasi Samehadaku (Sebagai fondasi dasar)
    // Ingat: runSync() akan mengeksekusi semua halaman secara perlahan agar tidak kena blokir
    console.log("\n[4/6] Menarik fondasi utama dari Samehadaku (Bisa memakan waktu 10-20 menit)...");
    await runSync();
    console.log("✅ Sinkronisasi Samehadaku tuntas!");
    
    // 5. Sinkronisasi Otakudesu, Neosatsu & Kuronime
    console.log("\n[5/6] Mengambil data tambahan & menggabungkan (Otakudesu, Neosatsu & Kuronime)...");
    await syncOtakudesu();
    console.log("✅ Sinkronisasi Otakudesu tuntas!");
    await syncNeosatsu();
    console.log("✅ Sinkronisasi Tokusatsu (Neosatsu) tuntas!");
    await syncKuronime();
    console.log("✅ Sinkronisasi Kuronime tuntas!");
    
    // 6. Enrichment TMDB (Proses berulang sampai antrean habis terpoles semua)
    console.log("\n[6/6] Memulai pengayaan metadata dari TMDB (Bisa memakan waktu)...");
    let hasMore = true;
    let cycles = 0;
    while (hasMore) {
        cycles++;
        console.log(`\n--- TMDB Enrichment Siklus ${cycles} (50 Anime) ---`);
        hasMore = await syncUnified();
        if (hasMore) {
            console.log("Menunggu 5 detik agar tidak memicu Rate Limit/Pemblokiran dari TMDB...");
            await new Promise(r => setTimeout(r, 5000));
        }
    }
    
    console.log("\n=====================================================");
    console.log("🎉 REBUILD DATABASE SELESAI SEMPURNA!");
    console.log("Semua data anime kini bersih dari duplikasi, sangat akurat, dan telah ter-enrichment!");
    console.log("=====================================================");
    
    // Tutup koneksi browser agar terminal (skrip) bisa berhenti dengan bersih
    try {
        const browser = await getBrowser();
        if (browser) await browser.close();
    } catch(e) {}
    process.exit(0);
}

rebuildDatabase().catch(err => {
    console.error("❌ Gagal Rebuild Database secara Fatal:", err);
    process.exit(1);
});
