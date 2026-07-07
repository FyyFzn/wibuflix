import mongoose from 'mongoose';
import dotenv from 'dotenv';
import connectDB from '../config/db.js';
import Anime from '../models/Anime.js';

dotenv.config();

/**
 * Skrip Sanitasi & Standarisasi Database Satu-Kali (One-Time Database Sanitization)
 * 
 * Skrip ini membersihkan dokumen di database dari "pencemaran data lama" (data pollution):
 * 1. Menentukan dan mengeset flag `isToku` secara akurat (true/false) agar pemilahan katalog tidak keliru.
 * 2. Menghapus tipe kotor seperti "Anime", "Toku", "Kamen Rider" dari kolom `type` dan `tipe`,
 *    menggantinya dengan format standar resmi: TV, Movie, OVA, ONA, Special, atau BD.
 * 3. Membersihkan array `tags` dari tag yang dilarang (seperti "Anime", "Toku", "Kamen Rider", dll.)
 *    Sesuai prinsip: Tag tidak menyimpan format/jenis media atau nama franchise besar.
 */

async function sanitizeDatabase() {
    console.log('[Sanitize DB] 🚀 Memulai pembersihan dan standarisasi seluruh dokumen di database...');
    
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) {
        console.error("\n❌ [Sanitize DB] GAGAL: Variabel MONGODB_URI/MONGO_URI belum diatur!");
        console.error("💡 Tips: Pastikan Anda telah membuat file .env yang berisi MONGODB_URI/MONGO_URI, atau jalankan perintah dengan menyisipkan URI secara langsung:");
        console.error("   MONGODB_URI='mongodb+srv://user:pass@cluster.mongodb.net/wibuflix' node src/scripts/sanitize_database.js\n");
        process.exit(1);
    }

    await connectDB();

    const allDocs = await Anime.find({});
    console.log(`[Sanitize DB] 📦 Ditemukan total ${allDocs.length} dokumen untuk diperiksa.`);

    let updatedCount = 0;
    let tokuCount = 0;
    let animeCount = 0;

    const validTypes = new Set(['TV', 'Movie', 'OVA', 'ONA', 'Special', 'BD']);
    const forbiddenTagsRegex = /^(anime|toku|tokusatsu|kamen rider|super sentai|ultraman|power rangers|tv|movie|ova|ona|special|bd|live action|ongoing|completed|sub indo|subtitle indonesia|batch|ongoing|end)$/i;

    for (const doc of allDocs) {
        let modified = false;

        // 1. Standarisasi flag isToku
        const isTokuSource = !!(doc.sources && doc.sources.neosatsu && doc.sources.neosatsu.url);
        const isTokuTitle = /(kamen rider|super sentai|ultraman|power rangers|garo|metal hero|toku|tokusatsu)/i.test(doc.title || '');
        const isTokuType = (doc.type === 'Toku' || doc.tipe === 'Toku');
        const isTokuTag = Array.isArray(doc.tags) && doc.tags.some(t => /(toku|tokusatsu|kamen rider|super sentai|ultraman)/i.test(t));

        const shouldBeToku = isTokuSource || isTokuTitle || isTokuType || isTokuTag;

        if (doc.isToku !== shouldBeToku) {
            doc.isToku = shouldBeToku;
            modified = true;
        }

        if (shouldBeToku) {
            tokuCount++;
            // Tokusatsu selalu bebas malId agar tidak bentrok dengan MyAnimeList
            if (doc.malId !== null) {
                doc.malId = null;
                modified = true;
            }
        } else {
            animeCount++;
        }

        // 2. Standarisasi kolom `type` & `tipe`
        let targetType = 'TV'; // Default standar
        if (validTypes.has(doc.type)) {
            targetType = doc.type;
        } else if (validTypes.has(doc.tipe)) {
            targetType = doc.tipe;
        } else {
            // Coba tebak dari judul atau kata kunci
            const titleLower = (doc.title || '').toLowerCase();
            if (titleLower.includes('movie') || titleLower.includes('gekijouban') || doc.type?.toLowerCase() === 'movie') {
                targetType = 'Movie';
            } else if (titleLower.includes('ova') || doc.type?.toLowerCase() === 'ova') {
                targetType = 'OVA';
            } else if (titleLower.includes('special') || titleLower.includes('sp') || doc.type?.toLowerCase() === 'special') {
                targetType = 'Special';
            } else if (titleLower.includes('ona') || doc.type?.toLowerCase() === 'ona') {
                targetType = 'ONA';
            } else if (titleLower.includes('bd') || doc.type?.toLowerCase() === 'bd') {
                targetType = 'BD';
            }
        }

        if (doc.type !== targetType || doc.tipe !== targetType) {
            doc.type = targetType;
            doc.tipe = targetType;
            modified = true;
        }

        // 3. Pembersihan array `tags` dari tag kotor / dilarang
        if (Array.isArray(doc.tags)) {
            const originalLength = doc.tags.length;
            const cleanTags = doc.tags
                .map(t => typeof t === 'string' ? t.trim() : '')
                .filter(t => t.length > 0 && !forbiddenTagsRegex.test(t));
            
            // Hapus duplikat tag
            const uniqueTags = Array.from(new Set(cleanTags));

            if (uniqueTags.length !== originalLength || uniqueTags.some((t, i) => t !== doc.tags[i])) {
                doc.tags = uniqueTags;
                modified = true;
            }
        }

        if (modified) {
            await doc.save();
            updatedCount++;
            console.log(`[Sanitize DB] 🧹 Diperbaiki (${shouldBeToku ? 'TOKU' : 'ANIME'} - ${targetType}): "${doc.title}"`);
        }
    }

    console.log('\n==================================================');
    console.log('   HASIL SANITASI & STANDARISASI DATABASE');
    console.log('==================================================');
    console.log(`📦 Total Dokumen Diperiksa : ${allDocs.length}`);
    console.log(`✨ Dokumen Diperbaiki      : ${updatedCount}`);
    console.log(`🎌 Total Anime Standar     : ${animeCount}`);
    console.log(`🦸 Total Tokusatsu Standar : ${tokuCount}`);
    console.log('==================================================');
    console.log('[Sanitize DB] ✅ Seluruh database kini bersih dari pencemaran tag/tipe lama!');
    
    process.exit(0);
}

sanitizeDatabase().catch(err => {
    console.error('[Sanitize DB] ❌ Gagal melakukan sanitasi:', err);
    process.exit(1);
});
