import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Anime from '../models/Anime.js';
import { cleanSeriesTitle, normalizeTitleForMatch } from '../utils/stringUtils.js';

async function cleanDuplicates() {
    console.log('[Clean Duplicates] Menghubungkan ke database...');
    await connectDB();

    try {
        console.log('[Clean Duplicates] 1. Memperbaiki dan membersihkan seluruh judul anime dari sampah nomor episode (#XX / Episode XX)...');
        const allDocs = await Anime.find({});
        let cleanedTitlesCount = 0;

        for (const doc of allDocs) {
            const newTitle = cleanSeriesTitle(doc.title);
            const newNorm = normalizeTitleForMatch(newTitle);
            if (doc.title !== newTitle || doc.normalizedTitle !== newNorm) {
                doc.title = newTitle;
                doc.normalizedTitle = newNorm;
                await doc.save();
                cleanedTitlesCount++;
            }
        }
        console.log(`[Clean Duplicates] ${cleanedTitlesCount} judul anime berhasil dibersihkan/dinormalisasi ulang.`);

        console.log('[Clean Duplicates] 2. Mencari dan meleburkan duplikat berdasarkan malId...');
        await mergeGroupByPipeline([
            { $match: { malId: { $ne: null } } },
            { $group: { _id: '$malId', count: { $sum: 1 }, docs: { $push: '$$ROOT' } } },
            { $match: { count: { $gt: 1 } } }
        ], 'malId');

        console.log('[Clean Duplicates] 3. Mencari dan meleburkan duplikat berdasarkan normalizedTitle...');
        await mergeGroupByPipeline([
            { $match: { normalizedTitle: { $ne: null, $ne: '' } } },
            { $group: { _id: '$normalizedTitle', count: { $sum: 1 }, docs: { $push: '$$ROOT' } } },
            { $match: { count: { $gt: 1 } } }
        ], 'normalizedTitle');

        console.log('\n[Clean Duplicates] Seluruh proses pembersihan dan peleburan selesai total!');
    } catch (err) {
        console.error('[Clean Duplicates] Error:', err);
    } finally {
        mongoose.connection.close();
    }
}

async function mergeGroupByPipeline(pipeline, groupType) {
    const aggregated = await Anime.aggregate(pipeline);
    console.log(`[Clean Duplicates - ${groupType}] Ditemukan ${aggregated.length} grup duplikat.`);

    let mergedCount = 0;
    let deletedCount = 0;

    for (const group of aggregated) {
        const docs = group.docs.sort((a, b) => {
            if (b.isLocked !== a.isLocked) return (b.isLocked ? 1 : 0) - (a.isLocked ? 1 : 0);
            if ((b.malId !== null) !== (a.malId !== null)) return (b.malId !== null ? 1 : 0) - (a.malId !== null ? 1 : 0);
            return (b.lastUpdated?.getTime() || 0) - (a.lastUpdated?.getTime() || 0);
        });
        const primary = docs[0];
        const duplicates = docs.slice(1);

        console.log(`\nMeleburkan ${groupType} "${group._id}": Utama="${primary.title}" (${duplicates.length} duplikat)`);

        for (const dup of duplicates) {
            if (!primary.sources) primary.sources = {};
            const providers = ['samehadaku', 'otakudesu', 'kuronime', 'neosatsu', 'nimegami', 'oploverz', 'nanime'];
            for (const prov of providers) {
                if (dup.sources?.[prov]?.url && !primary.sources?.[prov]?.url) {
                    primary.sources[prov] = dup.sources[prov];
                }
            }

            const aliases = new Set([...(primary.aliases || []), ...(dup.aliases || []), dup.title]);
            primary.aliases = Array.from(aliases).filter(a => a && a !== primary.title);

            await Anime.deleteOne({ _id: dup._id });
            deletedCount++;
        }

        await Anime.updateOne({ _id: primary._id }, {
            $set: {
                sources: primary.sources,
                aliases: primary.aliases
            }
        });
        mergedCount++;
    }
    console.log(`[Clean Duplicates - ${groupType}] ${mergedCount} grup dilebur, ${deletedCount} dokumen duplikat dihapus.`);
}

cleanDuplicates();

