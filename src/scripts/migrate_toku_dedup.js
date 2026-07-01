import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Anime from '../models/Anime.js';
import { normalizeTitleForMatch } from '../utils/stringUtils.js';

async function migrateTokuDedup() {
    console.log('[Migrate Toku Dedup] 🚀 Memulai migrasi pembersihan malId & deduplikasi Tokusatsu...');
    await connectDB();

    // 1. Bersihkan malId pada semua data Tokusatsu
    const res1 = await Anime.updateMany(
        { $or: [{ type: 'Toku' }, { 'sources.neosatsu.url': { $ne: null } }] },
        { $set: { malId: null } }
    );
    console.log(`[Migrate Toku Dedup] Membersihkan malId pada ${res1.modifiedCount} dokumen Tokusatsu.`);

    // 2. Bersihkan duplikat Tokusatsu yang terlanjur ada di database
    const allTokuDocs = await Anime.find({ $or: [{ type: 'Toku' }, { 'sources.neosatsu.url': { $ne: null } }] });
    const seenTokuMap = new Map();
    let removedCount = 0;

    for (const doc of allTokuDocs) {
        const normKey = normalizeTitleForMatch(doc.title);
        if (!normKey) continue;

        if (seenTokuMap.has(normKey)) {
            const primaryDoc = seenTokuMap.get(normKey);
            if (doc.sources) {
                if (doc.sources.neosatsu?.url && !primaryDoc.sources.neosatsu?.url) {
                    primaryDoc.sources.neosatsu = doc.sources.neosatsu;
                }
                if (doc.sources.samehadaku?.url && !primaryDoc.sources.samehadaku?.url) {
                    primaryDoc.sources.samehadaku = doc.sources.samehadaku;
                }
                if (doc.sources.otakudesu?.url && !primaryDoc.sources.otakudesu?.url) {
                    primaryDoc.sources.otakudesu = doc.sources.otakudesu;
                }
                if (doc.sources.kuronime?.url && !primaryDoc.sources.kuronime?.url) {
                    primaryDoc.sources.kuronime = doc.sources.kuronime;
                }
            }
            const mergedAliases = new Set([...(primaryDoc.aliases || []), ...(doc.aliases || []), doc.title]);
            primaryDoc.aliases = Array.from(mergedAliases).filter(Boolean);
            if ((!primaryDoc.episodesList || primaryDoc.episodesList.length === 0) && doc.episodesList?.length > 0) {
                primaryDoc.episodesList = doc.episodesList;
            }
            primaryDoc.malId = null;
            await primaryDoc.save();
            console.log(`[Migrate Toku Dedup] 🧹 Menghapus duplikat Tokusatsu: "${doc.title}" (_id: ${doc._id})`);
            await Anime.deleteOne({ _id: doc._id });
            removedCount++;
        } else {
            doc.malId = null;
            if (!doc.normalizedTitle) {
                doc.normalizedTitle = normKey;
                await doc.save();
            }
            seenTokuMap.set(normKey, doc);
        }
    }

    console.log(`[Migrate Toku Dedup] ✅ Selesai! Menghapus ${removedCount} duplikat Tokusatsu.`);
    process.exit(0);
}

migrateTokuDedup().catch(err => {
    console.error('[Migrate Toku Dedup] ❌ Gagal menjalankan migrasi:', err);
    process.exit(1);
});
