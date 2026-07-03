import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Anime from '../models/Anime.js';

async function cleanDuplicates() {
    console.log('[Clean Duplicates] Menghubungkan ke database...');
    await connectDB();

    try {
        console.log('[Clean Duplicates] Mencari duplikat berdasarkan malId...');
        const aggregated = await Anime.aggregate([
            { $match: { malId: { $ne: null } } },
            { $group: { _id: '$malId', count: { $sum: 1 }, docs: { $push: '$$ROOT' } } },
            { $match: { count: { $gt: 1 } } }
        ]);

        console.log(`[Clean Duplicates] Ditemukan ${aggregated.length} malId dengan entitas duplikat.`);

        let mergedCount = 0;
        let deletedCount = 0;

        for (const group of aggregated) {
            // Urutkan agar dokumen utama adalah yang terkunci (isLocked) atau yang paling lengkap / baru
            const docs = group.docs.sort((a, b) => (b.isLocked ? 1 : 0) - (a.isLocked ? 1 : 0));
            const primary = docs[0];
            const duplicates = docs.slice(1);

            console.log(`\nMeleburkan malId ${group._id}: Utama="${primary.title}" (${duplicates.length} duplikat)`);

            for (const dup of duplicates) {
                // Gabungkan sources
                if (dup.sources?.samehadaku?.url && !primary.sources?.samehadaku?.url) {
                    primary.sources.samehadaku = dup.sources.samehadaku;
                }
                if (dup.sources?.otakudesu?.url && !primary.sources?.otakudesu?.url) {
                    primary.sources.otakudesu = dup.sources.otakudesu;
                }
                if (dup.sources?.kuronime?.url && !primary.sources?.kuronime?.url) {
                    primary.sources.kuronime = dup.sources.kuronime;
                }
                if (dup.sources?.neosatsu?.url && !primary.sources?.neosatsu?.url) {
                    primary.sources.neosatsu = dup.sources.neosatsu;
                }

                // Gabungkan alias
                const aliases = new Set([...(primary.aliases || []), ...(dup.aliases || []), dup.title]);
                primary.aliases = Array.from(aliases);

                // Hapus duplikat
                await Anime.deleteOne({ _id: dup._id });
                deletedCount++;
            }

            // Update primary doc
            await Anime.updateOne({ _id: primary._id }, {
                $set: {
                    sources: primary.sources,
                    aliases: primary.aliases
                }
            });
            mergedCount++;
        }

        console.log(`\n[Clean Duplicates] Selesai! ${mergedCount} grup dilebur, ${deletedCount} dokumen duplikat dihapus.`);
    } catch (err) {
        console.error('[Clean Duplicates] Error:', err);
    } finally {
        mongoose.connection.close();
    }
}

cleanDuplicates();
