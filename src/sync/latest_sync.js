import Anime from '../models/Anime.js';
import { cache as katalogCache } from '../controllers/katalogController.js';
import { ProviderRegistry } from '../services/ProviderRegistry.js';

let isLatestSyncing = false;

const log = (...args) => {
    if (global.forceLog) global.forceLog(...args);
    else console.log(...args);
};

export async function startBackgroundLatestSync() {
    log("[Latest Sync] Memulai penjadwalan pengecekan update episode (setiap 30 menit)...");
    
    // Jalankan pertama kali (tunggu 20 detik agar pool puppeteer siap)
    setTimeout(() => {
        runLatestSync();
    }, 20000);

    // Jadwalkan setiap 30 menit (1.800.000 ms)
    setInterval(() => {
        runLatestSync();
    }, 1800000);
}

export async function runLatestSync() {
    if (isLatestSyncing) return;
    isLatestSyncing = true;
    
    log(`\n===========================================`);
    log(`[Latest Sync] Memulai Fast-Sync Beranda All Providers via ProviderRegistry...`);
    log(`===========================================\n`);

    try {
        const providerIds = await ProviderRegistry.getAllProviderIds();
        for (const providerId of providerIds) {
            log(`[Latest Sync] Mengambil update terbaru dari ${providerId}...`);
            try {
                const updates = await ProviderRegistry.fetchLatestUpdates(providerId);
                if (updates && updates.length > 0) {
                    log(`[Latest Sync] Ditemukan ${updates.length} anime terupdate di ${providerId}. Melakukan sinkronisasi ke MongoDB...`);
                    const count = await processLatestUpdatesWithGuard(updates, providerId);
                    log(`[Latest Sync] ✅ ${providerId}: Berhasil mengupdate status/waktu ${count} anime.`);
                } else {
                    log(`[Latest Sync] Tidak ada elemen update yang terdeteksi di ${providerId}.`);
                }
            } catch (pErr) {
                console.error(`[Latest Sync] Error saat sinkronisasi ${providerId}:`, pErr.message);
            }
        }
    } catch (e) {
        console.error(`[Latest Sync] Error fatal:`, e.message);
    } finally {
        isLatestSyncing = false;
        log(`[Latest Sync] Selesai.\n`);
    }
}

function extractEpisodeNumFromText(text) {
    if (!text || typeof text !== 'string') return 0;
    const match = text.match(/(?:eps?|episode|ep)\s*(\d+(?:\.\d+)?)/i) || text.match(/(\d+(?:\.\d+)?)/);
    if (match && !isNaN(parseFloat(match[1]))) return parseFloat(match[1]);
    return 0;
}

async function processLatestUpdatesWithGuard(updates, providerName) {
    if (!updates || updates.length === 0) return 0;
    const { normalizeTitleForMatch } = await import('../utils/stringUtils.js');
    const now = Date.now();

    const normTitles = updates.map(u => normalizeTitleForMatch(u.judul || u.title)).filter(Boolean);
    const urls = updates.map(u => u.url).filter(Boolean);
    const filterOr = [{ normalizedTitle: { $in: normTitles } }];
    if (urls.length > 0) {
        filterOr.push({ sourceUrls: { $in: urls } });
    }

    const existingDocs = await Anime.find({ $or: filterOr });
    const docByTitle = new Map();
    const docByUrl = new Map();
    existingDocs.forEach(d => {
        if (d.normalizedTitle) docByTitle.set(d.normalizedTitle, d);
        if (d.sourceUrls && d.sourceUrls.length > 0) {
            d.sourceUrls.forEach(u => docByUrl.set(u, d));
        }
    });

    const bulkOps = [];
    let updatedCount = 0;

    for (let index = 0; index < updates.length; index++) {
        const item = updates[index];
        const title = item.judul || item.title;
        if (!title) continue;
        const normTitle = normalizeTitleForMatch(title);
        const doc = docByUrl.get(item.url) || docByTitle.get(normTitle);
        if (!doc) continue;

        const newStatus = item.status || '';
        const newEpNum = extractEpisodeNumFromText(newStatus);
        const oldEpNum = Math.max(doc.episodesCount || 0, extractEpisodeNumFromText(doc.status));

        let shouldUpdateStatus = false;
        let shouldUpdateTimestamp = false;

        // General update logic for all providers (Zero-hardcode!)
        if (newEpNum > oldEpNum || (newEpNum === oldEpNum && newEpNum > 0 && doc.status !== newStatus) || !doc.lastUpdated) {
            shouldUpdateStatus = true;
            shouldUpdateTimestamp = true;
        } else if (newEpNum >= oldEpNum) {
            shouldUpdateStatus = true;
        }

        const setFields = {};
        if (shouldUpdateStatus && newStatus) {
            setFields.status = newStatus;
            if (newEpNum > (doc.episodesCount || 0)) {
                setFields.episodesCount = newEpNum;
            }
        }
        if (shouldUpdateTimestamp) {
            setFields.lastUpdated = new Date(now - index * 1000);
        }
        const updateOp = { $set: setFields };
        if (item.url) {
            updateOp.$addToSet = { sourceUrls: item.url };
        }

        if (Object.keys(setFields).length > 0 || updateOp.$addToSet) {
            bulkOps.push({
                updateOne: {
                    filter: { _id: doc._id },
                    update: updateOp
                }
            });
            updatedCount++;
        }
    }

    if (bulkOps.length > 0) {
        await Anime.bulkWrite(bulkOps);
        if (katalogCache && typeof katalogCache.flushAll === 'function') {
            katalogCache.flushAll();
        }
    }
    return updatedCount;
}



