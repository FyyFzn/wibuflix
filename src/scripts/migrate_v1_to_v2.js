import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../../.env') });

import Anime from '../models/Anime.js';

async function migrate() {
    console.log("Menghubungkan ke MongoDB...");
    await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
    console.log("✅ Terhubung!");

    console.log("Mencari dokumen yang masih menggunakan objek 'sources' lama...");
    const animes = await Anime.find({ sources: { $exists: true, $ne: {} } });
    console.log(`Ditemukan ${animes.length} anime yang perlu dimigrasi.`);

    let updatedCount = 0;

    const bulkOps = [];

    for (const doc of animes) {
        const anime = doc.toObject(); // Convert Mongoose document to plain JS object to safely read Maps
        if (!anime.sources) continue;

        // Kumpulkan semua URL dari objek sources lama
        const oldUrls = Object.values(anime.sources)
            .map(s => s && s.url)
            .filter(Boolean);

        if (oldUrls.length > 0) {
            // Gabungkan URL lama dengan sourceUrls yang sudah ada (jangan ada duplikat)
            const currentUrls = anime.sourceUrls || [];
            const mergedSet = new Set([...currentUrls, ...oldUrls]);
            const finalUrls = Array.from(mergedSet);

            bulkOps.push({
                updateOne: {
                    filter: { _id: anime._id },
                    update: { 
                        $set: { sourceUrls: finalUrls },
                        $unset: { sources: "" }
                    }
                }
            });
            updatedCount++;
        } else {
            bulkOps.push({
                updateOne: {
                    filter: { _id: anime._id },
                    update: { $unset: { sources: "" } }
                }
            });
        }
    }

    if (bulkOps.length > 0) {
        console.log(`Menjalankan Bulk Write untuk ${bulkOps.length} dokumen...`);
        await Anime.collection.bulkWrite(bulkOps);
    }

    console.log(`\n🎉 Misi Selesai! Berhasil memigrasi & membersihkan ${updatedCount} anime.`);
    console.log("Variabel super 'sourceUrls' sekarang sudah terisi 100% secara instan!");
    process.exit(0);
}

migrate().catch(e => {
    console.error("Error:", e);
    process.exit(1);
});
