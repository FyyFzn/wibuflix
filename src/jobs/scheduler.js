import { syncUnified } from '../sync/unified_sync.js';
import { startBackgroundAnimeSync } from '../sync/anime_sync.js';
import { startBackgroundOtakuSync } from '../sync/otaku_sync.js';
import { runLatestSync } from '../sync/latest_sync.js';
import { syncNeosatsu } from '../sync/neosatsu_sync.js';
import { startBackgroundKuronimeSync } from '../sync/kuronime_sync.js';
import { startBackgroundNanimeSync } from '../sync/nanime_sync.js';
import { startBackgroundNimegamiSync } from '../sync/nimegami_sync.js';
import { startBackgroundOploverzSync } from '../sync/oploverz_sync.js';
import { startBackgroundYlnimeSync } from '../sync/ylnime_sync.js';
import { scheduledCleanup } from '../utils/tempFileCleanupWorker.js';
import { scheduledBlobCleanup } from '../utils/blobCleanupWorker.js';
import { startBackgroundLogMonitor } from '../services/aiLogMonitorService.js';

export function initScheduler() {
    const log = global.forceLog || console.log;
    log('⏳ [Scheduler] Memulai inisialisasi background jobs...');

    // 1. Memulai sync aktif (real-time listeners)
    startBackgroundAnimeSync();
    startBackgroundOtakuSync();
    // Latest sync: run once after 20s (pool warm-up), then every 30 minutes
    setTimeout(() => runLatestSync(), 20000);
    setInterval(() => runLatestSync(), 1800000);
    startBackgroundKuronimeSync();
    startBackgroundNanimeSync();
    startBackgroundNimegamiSync();
    startBackgroundOploverzSync();
    startBackgroundYlnimeSync();

    // 2. Memulai proses unified sync (dijadwalkan setelah 10 detik agar server stabil)
    setTimeout(() => {
        const runUnifiedLoop = async () => {
            let hasMore = false;
            try {
                hasMore = await syncUnified();
            } catch (err) {
                console.error("[Scheduler] Error Unified Sync:", err);
            }
            
            // Backoff Cerdas: Jika antrean masih ada, tunggu 2 menit saja. Jika habis, tidur 1 jam.
            const nextDelay = hasMore ? (2 * 60 * 1000) : (60 * 60 * 1000);
            setTimeout(runUnifiedLoop, nextDelay);
        };
        runUnifiedLoop();
        
        const runNeosatsuLoop = async () => {
            await syncNeosatsu().catch(err => console.error("[Scheduler] Error Neosatsu Sync:", err));
            setTimeout(runNeosatsuLoop, 604800000);
        };
        runNeosatsuLoop();
    }, 10000);

    // 3. Pembersihan file sampah temporer (Garbage Collection) setiap 12 jam
    scheduledCleanup();

    // 3b. Pembersihan blob Azure kadaluarsa (lebih dari 7 hari) setiap 24 jam
    scheduledBlobCleanup();

    // 4. Background AI Log Monitor (evaluasi error spike setiap 15 menit)
    startBackgroundLogMonitor(15 * 60 * 1000);

    log('✅ [Scheduler] Semua background jobs & garbage collector berhasil dijadwalkan!');
}
