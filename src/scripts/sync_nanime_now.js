import dotenv from 'dotenv';
import connectDB from '../config/db.js';
import { syncNanimeCatalog } from '../sync/nanime_sync.js';

dotenv.config();

/**
 * Skrip Sinkronisasi Manual Katalog Nanime ID A-Z (Standalone Script)
 * 
 * Skrip ini dapat dijalankan kapan pun melalui terminal untuk menarik seluruh katalog A-Z
 * dari endpoint /explore Nanime ID dan menyimpannya langsung ke database MongoDB.
 */

async function runManualNanimeSync() {
    console.log('[Manual Nanime Sync] 🚀 Memulai sinkronisasi katalog A-Z Nanime ID...');
    
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) {
        console.error("\n❌ [Manual Nanime Sync] GAGAL: Variabel MONGODB_URI/MONGO_URI belum diatur!");
        console.error("💡 Tips: Pastikan file .env Anda berisi MONGODB_URI, atau jalankan dengan perintah:");
        console.error("   MONGODB_URI='mongodb+srv://user:pass@cluster.mongodb.net/wibuflix' node src/scripts/sync_nanime_now.js\n");
        process.exit(1);
    }

    if (!process.env.NANIME_COOKIE) {
        console.warn("⚠️ [Manual Nanime Sync] PERINGATAN: NANIME_COOKIE tidak ditemukan di .env!");
        console.warn("💡 Skrip tetap berjalan dalam mode publik/gratis. Untuk akses link VIP/download khusus, tambahkan cookie akun Anda di .env.\n");
    } else {
        console.log("🍪 [Manual Nanime Sync] Cookie akun terdeteksi! Menggunakan sesi terotentikasi.");
    }

    await connectDB();

    try {
        await syncNanimeCatalog();
        console.log('\n✅ [Manual Nanime Sync] Sinkronisasi katalog Nanime ID A-Z berhasil diselesaikan!');
    } catch (err) {
        console.error('\n❌ [Manual Nanime Sync] Error saat sinkronisasi:', err.message);
    } finally {
        process.exit(0);
    }
}

runManualNanimeSync();
