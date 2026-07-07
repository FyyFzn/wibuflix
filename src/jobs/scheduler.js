import { syncUnified } from '../sync/unified_sync.js';
import { startBackgroundAnimeSync } from '../sync/anime_sync.js';
import { startBackgroundOtakuSync } from '../sync/otaku_sync.js';
import { startBackgroundLatestSync } from '../sync/latest_sync.js';
import { syncNeosatsu } from '../sync/neosatsu_sync.js';
import { startBackgroundKuronimeSync } from '../sync/kuronime_sync.js';
import { startBackgroundNanimeSync } from '../sync/nanime_sync.js';

export function initScheduler() {
    const log = global.forceLog || console.log;
    log('⏳ [Scheduler] Memulai inisialisasi background jobs...');

    // 1. Memulai sync aktif (real-time listeners)
    startBackgroundAnimeSync();
    startBackgroundOtakuSync();
    startBackgroundLatestSync();
    startBackgroundKuronimeSync();
    startBackgroundNanimeSync();

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
    import('fs').then(fs => {
        import('path').then(path => {
            import('os').then(os => {
                const cleanStaleTempFiles = () => {
                    const tmpDir = path.join(os.tmpdir(), 'wibuflix_temp');
                    if (!fs.existsSync(tmpDir)) return;
                    fs.readdir(tmpDir, (err, files) => {
                        if (err) return;
                        const now = Date.now();
                        files.forEach(file => {
                            if (file.startsWith('hls_') || file.includes('.part')) {
                                const filePath = path.join(tmpDir, file);
                                fs.stat(filePath, (statErr, stats) => {
                                    if (stats && (now - stats.mtimeMs > 4 * 60 * 60 * 1000)) {
                                        fs.rm(filePath, { recursive: true, force: true }, () => {
                                            log(`[CleanUp] 🧹 Hapus file/folder sampah lawas: ${file}`);
                                        });
                                    }
                                });
                            }
                        });
                    });
                };
                cleanStaleTempFiles(); // Jalankan sekali saat start
                setInterval(cleanStaleTempFiles, 12 * 60 * 60 * 1000);
            });
        });
    }).catch(() => {});

    log('✅ [Scheduler] Semua background jobs & garbage collector berhasil dijadwalkan!');
}
