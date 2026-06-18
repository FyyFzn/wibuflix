import { syncUnified } from '../sync/unified_sync.js';
import { startBackgroundAnimeSync } from '../sync/anime_sync.js';
import { startBackgroundOtakuSync } from '../sync/otaku_sync.js';
import { startBackgroundLatestSync } from '../sync/latest_sync.js';
import { syncNeosatsu } from '../sync/neosatsu_sync.js';
import { startBackgroundKuronimeSync } from '../sync/kuronime_sync.js';

export function initScheduler() {
    const log = global.forceLog || console.log;
    log('⏳ [Scheduler] Memulai inisialisasi background jobs...');

    // 1. Memulai sync aktif (real-time listeners)
    startBackgroundAnimeSync();
    startBackgroundOtakuSync();
    startBackgroundLatestSync();
    startBackgroundKuronimeSync();

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

    log('✅ [Scheduler] Semua background jobs berhasil dijadwalkan!');
}
