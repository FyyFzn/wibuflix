import mongoose from 'mongoose';
import dotenv from 'dotenv';
import connectDB from '../config/db.js';
import Anime from '../models/Anime.js';
import { sanitizeContaminatedEpisodeCards } from '../services/episodeService.js';

dotenv.config();

/**
 * Skrip Pembersihan Kontaminasi OVA / Special di Database (OVA Contamination Sanitizer)
 * 
 * Skrip ini memindai seluruh dokumen Anime di MongoDB dan memeriksa array `episodesList`:
 * 1. Menghapus URL provider OVA/Special (seperti /ova/, -ova-, -ex-) yang keliru terselip di dalam kartu episode normal (Ep 1, Ep 2, dst.).
 * 2. Memastikan kartu episode OVA/Special tidak memiliki nomor episode regular (`num: null`) agar tidak menggantikan episode utama.
 */
async function sanitizeOvaContamination() {
    console.log('[Sanitize OVA] 🚀 Memulai pemeriksaan kontaminasi OVA pada seluruh dokumen Anime...');
    
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) {
        console.error("\n❌ [Sanitize OVA] GAGAL: Variabel MONGODB_URI/MONGO_URI belum diatur di .env!");
        process.exit(1);
    }

    await connectDB();

    const allDocs = await Anime.find({});
    console.log(`[Sanitize OVA] 📦 Ditemukan total ${allDocs.length} dokumen untuk diperiksa.`);

    let updatedDocs = 0;
    let totalUrlsCleaned = 0;
    let totalCardsFixed = 0;

    for (const doc of allDocs) {
        if (!doc.episodesList || !Array.isArray(doc.episodesList) || doc.episodesList.length === 0) {
            continue;
        }

        let modified = false;
        const rawEps = doc.episodesList.map(ep => {
            const epObj = ep.toObject ? ep.toObject({ flattenMaps: true }) : { ...ep };
            if (epObj.urls && (epObj.urls instanceof Map || typeof epObj.urls.entries === 'function')) {
                epObj.urls = Object.fromEntries(epObj.urls);
            }
            return epObj;
        });

        const cleanedEps = sanitizeContaminatedEpisodeCards(rawEps);

        for (let i = 0; i < rawEps.length; i++) {
            const oldEp = rawEps[i];
            const newEp = cleanedEps[i];

            if (oldEp.num !== newEp.num) {
                modified = true;
                totalCardsFixed++;
            }

            const oldUrls = oldEp.urls || {};
            const newUrls = newEp.urls || {};
            if (Object.keys(oldUrls).length !== Object.keys(newUrls).length) {
                modified = true;
                totalUrlsCleaned += (Object.keys(oldUrls).length - Object.keys(newUrls).length);
            }
        }

        if (modified) {
            doc.episodesList = cleanedEps;
            await doc.save();
            updatedDocs++;
            console.log(`[Sanitize OVA] 🧹 Diperbaiki dokumen: "${doc.title}"`);
        }
    }

    console.log('\n==================================================');
    console.log('   HASIL SANITASI KONTAMINASI OVA DATABASE');
    console.log('==================================================');
    console.log(`📦 Total Dokumen Diperiksa   : ${allDocs.length}`);
    console.log(`✨ Dokumen Diperbaiki        : ${updatedDocs}`);
    console.log(`🛡️ Total URL OVA Dihapus     : ${totalUrlsCleaned}`);
    console.log(`🔢 Total Kartu OVA Diperbaiki: ${totalCardsFixed}`);
    console.log('==================================================');
    console.log('[Sanitize OVA] ✅ Seluruh database kini bersih dari kontaminasi OVA!');
    
    process.exit(0);
}

sanitizeOvaContamination().catch(err => {
    console.error('[Sanitize OVA] ❌ Gagal melakukan sanitasi:', err);
    process.exit(1);
});
