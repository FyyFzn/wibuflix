import dotenv from 'dotenv';
dotenv.config();
import connectDB from '../config/db.js';
import Anime from '../models/Anime.js';
import { cache as katalogCache } from '../controllers/katalogController.js';

async function healLastUpdated() {
    console.log('[Heal DB] 🏥 Memulai penyembuhan timestamp lastUpdated untuk anime lama yang terpolusi...');
    await connectDB();

    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

    // Cari anime yang berstatus Completed/Tamat, dibuat lebih dari 3 hari lalu, tetapi lastUpdated-nya baru saja diubah (oleh bug saat user menonton/membuka detail)
    const pollutedDocs = await Anime.find({
        status: { $regex: /^Completed$|^Complete$|^End$|^Tamat$|^Finished$|\bEND\b|^\d+\s*Episode$/i },
        createdAt: { $lt: threeDaysAgo },
        $expr: {
            $gt: ["$lastUpdated", { $dateAdd: { startDate: "$createdAt", unit: "day", amount: 2 } }]
        }
    });

    console.log(`[Heal DB] 📦 Ditemukan ${pollutedDocs.length} anime lama bertanda Completed yang timestamp lastUpdated-nya terpolusi bug.`);

    let healedCount = 0;
    const bulkOps = [];

    for (const doc of pollutedDocs) {
        bulkOps.push({
            updateOne: {
                filter: { _id: doc._id },
                update: { $set: { lastUpdated: doc.createdAt || doc._id.getTimestamp() } }
            }
        });
        healedCount++;
        console.log(`[Heal DB] 🩹 Memperbaiki timestamp: "${doc.title}" -> ${doc.createdAt?.toISOString() || doc._id.getTimestamp().toISOString()}`);
    }

    if (bulkOps.length > 0) {
        await Anime.bulkWrite(bulkOps);
        if (katalogCache && typeof katalogCache.flushAll === 'function') {
            katalogCache.flushAll();
        }
        console.log(`[Heal DB] ✅ Berhasil menyembuhkan ${healedCount} anime & memuat ulang cache katalog!`);
    } else {
        console.log('[Heal DB] 👍 Tidak ada anime yang perlu disembuhkan.');
    }

    process.exit(0);
}

healLastUpdated().catch(err => {
    console.error('[Heal DB] ❌ Error:', err);
    process.exit(1);
});
