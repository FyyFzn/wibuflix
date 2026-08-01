import connectDB from './src/config/db.js';
import { syncYlnime } from './src/sync/ylnime_sync.js';
import mongoose from 'mongoose';

async function runInitialScrape() {
    console.log("Menghubungkan ke database...");
    await connectDB();
    
    console.log("\nMemulai proses scrapping awal katalog YLnime...");
    try {
        await syncYlnime();
        console.log("\nProses scrapping selesai!");
    } catch (err) {
        console.error("Terjadi kesalahan saat scrapping:", err);
    } finally {
        await mongoose.disconnect();
        console.log("Koneksi database ditutup.");
        process.exit(0);
    }
}

runInitialScrape();
