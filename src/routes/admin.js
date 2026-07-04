import express from 'express';
import { flushAll } from '../utils/cacheManager.js';
import { runSync } from '../sync/anime_sync.js';
import { syncUnified } from '../sync/unified_sync.js';

const router = express.Router();

// ============================================================
// RUTE 7: GET /api/cache-clear  [DEV only]
// ============================================================
router.get('/api/cache-clear', (req, res) => {
    flushAll();
    res.json({ status: 'ok', message: 'Cache cleared' });
});

// ============================================================
// RUTE 7.5: GET /api/admin/logs/raw  [DATA MENTAH LOG]
// ============================================================
router.get('/api/admin/logs/raw', (req, res) => {
    res.type('text/plain');
    res.send(global.memLogs ? global.memLogs.join('\n') : 'Menunggu log...');
});

// ============================================================
// RUTE 7.6: GET /api/admin/logs  [UI LOG STREAM REAL-TIME]
// ============================================================
router.get('/api/admin/logs', (req, res) => {
    const html = `
    <html>
        <head>
            <title>WibuFlix Live Log Stream</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                * { box-sizing: border-box; }
                body { background-color: #0d1117; color: #c9d1d9; font-family: 'Courier New', Courier, monospace; padding: 0; margin: 0; font-size: 13px; line-height: 1.6; }
                
                #header { position: fixed; top: 0; left: 0; right: 0; background: #161b22; border-bottom: 1px solid #30363d; z-index: 100; padding: 8px 12px; }
                .header-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
                h3 { margin: 0; color: #fff; font-size: 14px; }
                .status { color: #39ff14; font-weight: bold; font-size: 12px; }
                .status.offline { color: #ff4444; }
                .status.paused { color: #f0ad4e; }
                
                .toolbar { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
                .toolbar button { 
                    background: #21262d; color: #c9d1d9; border: 1px solid #30363d; 
                    padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 11px; 
                    font-family: -apple-system, sans-serif; transition: all 0.15s;
                    white-space: nowrap;
                }
                .toolbar button:hover { background: #30363d; border-color: #8b949e; }
                .toolbar button:active { background: #484f58; }
                .toolbar button.active { background: #1f6feb; border-color: #1f6feb; color: #fff; }
                .toolbar button.success { background: #238636; border-color: #238636; color: #fff; }
                
                #searchBox { 
                    background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; 
                    padding: 4px 8px; border-radius: 6px; font-size: 11px; 
                    font-family: 'Courier New', monospace; flex: 1; min-width: 120px; max-width: 250px;
                    outline: none;
                }
                #searchBox:focus { border-color: #1f6feb; }
                #searchBox::placeholder { color: #484f58; }
                
                #logContainer { 
                    margin-top: 80px; padding: 12px; padding-bottom: 50px;
                    user-select: text; -webkit-user-select: text;
                }
                .log-line { 
                    padding: 1px 6px; border-radius: 3px; 
                    word-wrap: break-word; white-space: pre-wrap;
                    cursor: pointer; transition: background 0.1s;
                }
                .log-line:hover { background: #161b22; }
                .log-line.copied { background: #1a3a1a !important; }
                .log-line.highlight { background: #2a1f00; }
                .log-line .match { background: #6e5600; color: #fff; padding: 0 2px; border-radius: 2px; }
                
                .log-line.level-error { color: #ff7b72; }
                .log-line.level-warn { color: #f0ad4e; }
                .log-line.level-info { color: #58a6ff; }
                .log-line.level-log { color: #39ff14; }
                
                #toast { 
                    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); 
                    background: #238636; color: #fff; padding: 8px 16px; border-radius: 8px; 
                    font-size: 12px; font-family: -apple-system, sans-serif;
                    opacity: 0; transition: opacity 0.3s; pointer-events: none; z-index: 200;
                }
                #toast.show { opacity: 1; }
                
                #lineCount { color: #484f58; font-size: 11px; font-family: -apple-system, sans-serif; }
            </style>
        </head>
        <body>
            <div id="header">
                <div class="header-top">
                    <h3>🚀 WibuFlix Live Terminal</h3>
                    <div style="display:flex;align-items:center;gap:8px;">
                        <span id="lineCount"></span>
                        <span id="statusIndicator" class="status">● LIVE</span>
                    </div>
                </div>
                <div class="toolbar">
                    <input type="text" id="searchBox" placeholder="🔍 Cari log..." />
                    <button id="btnPause" onclick="togglePause()">⏸ Pause</button>
                    <button onclick="copyAll()">📋 Copy All</button>
                    <button onclick="downloadLogs()">💾 Download</button>
                    <button onclick="clearDisplay()">🗑 Clear</button>
                </div>
            </div>
            <div id="logContainer">Memuat log...</div>
            <div id="toast"></div>
            <script>
                const logContainer = document.getElementById('logContainer');
                const statusIndicator = document.getElementById('statusIndicator');
                const searchBox = document.getElementById('searchBox');
                const lineCountEl = document.getElementById('lineCount');
                const btnPause = document.getElementById('btnPause');
                let autoScroll = true;
                let isPaused = false;
                let rawText = '';
                let searchTerm = '';

                window.addEventListener('scroll', () => {
                    const isAtBottom = window.innerHeight + window.scrollY >= document.body.offsetHeight - 50;
                    autoScroll = isAtBottom;
                });

                searchBox.addEventListener('input', (e) => {
                    searchTerm = e.target.value.toLowerCase();
                    renderLogs(rawText);
                });

                function showToast(msg) {
                    const toast = document.getElementById('toast');
                    toast.textContent = msg;
                    toast.classList.add('show');
                    setTimeout(() => toast.classList.remove('show'), 1500);
                }

                function getLineClass(line) {
                    if (line.includes('[ERROR]')) return 'level-error';
                    if (line.includes('[WARN]')) return 'level-warn';
                    if (line.includes('[INFO]')) return 'level-info';
                    return 'level-log';
                }

                function escapeHtml(text) {
                    return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                }

                function renderLogs(text) {
                    const lines = text.split('\\n').filter(l => l.trim());
                    let filtered = lines;
                    if (searchTerm) {
                        filtered = lines.filter(l => l.toLowerCase().includes(searchTerm));
                    }
                    lineCountEl.textContent = searchTerm 
                        ? filtered.length + '/' + lines.length + ' baris'
                        : lines.length + ' baris';

                    logContainer.innerHTML = filtered.map((line, i) => {
                        let display = escapeHtml(line);
                        if (searchTerm) {
                            const regex = new RegExp('(' + searchTerm.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&') + ')', 'gi');
                            display = display.replace(regex, '<span class="match">$1</span>');
                        }
                        return '<div class="log-line ' + getLineClass(line) + '" onclick="copyLine(this, ' + i + ')" title="Klik untuk copy baris ini">' + display + '</div>';
                    }).join('');
                }

                function copyLine(el, idx) {
                    const text = el.textContent;
                    navigator.clipboard.writeText(text).then(() => {
                        el.classList.add('copied');
                        showToast('✓ Baris dicopy!');
                        setTimeout(() => el.classList.remove('copied'), 800);
                    }).catch(() => {
                        fallbackCopy(text);
                        showToast('✓ Baris dicopy!');
                    });
                }

                function copyAll() {
                    const text = searchTerm 
                        ? rawText.split('\\n').filter(l => l.toLowerCase().includes(searchTerm)).join('\\n')
                        : rawText;
                    navigator.clipboard.writeText(text).then(() => {
                        showToast('✓ Semua log dicopy ke clipboard!');
                    }).catch(() => {
                        fallbackCopy(text);
                        showToast('✓ Semua log dicopy!');
                    });
                }

                function fallbackCopy(text) {
                    const ta = document.createElement('textarea');
                    ta.value = text;
                    ta.style.position = 'fixed';
                    ta.style.left = '-9999px';
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    document.body.removeChild(ta);
                }

                function downloadLogs() {
                    const blob = new Blob([rawText], { type: 'text/plain' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'wibuflix-log-' + new Date().toISOString().slice(0,19).replace(/[:T]/g, '-') + '.txt';
                    a.click();
                    URL.revokeObjectURL(url);
                    showToast('✓ Log diunduh!');
                }

                function clearDisplay() {
                    logContainer.innerHTML = '<div class="log-line level-log">Display dibersihkan. Log berikutnya akan muncul saat refresh...</div>';
                }

                function togglePause() {
                    isPaused = !isPaused;
                    btnPause.textContent = isPaused ? '▶ Resume' : '⏸ Pause';
                    btnPause.classList.toggle('active', isPaused);
                    statusIndicator.textContent = isPaused ? '● PAUSED' : '● LIVE';
                    statusIndicator.className = isPaused ? 'status paused' : 'status';
                }

                async function fetchLogs() {
                    if (isPaused) return;
                    try {
                        const response = await fetch('/api/admin/logs/raw');
                        if (!response.ok) throw new Error('fail');
                        rawText = await response.text();
                        renderLogs(rawText);
                        if (!isPaused) {
                            statusIndicator.textContent = '● LIVE';
                            statusIndicator.className = 'status';
                        }
                        if (autoScroll && !searchTerm) {
                            window.scrollTo(0, document.body.scrollHeight);
                        }
                    } catch (error) {
                        statusIndicator.textContent = '● TERPUTUS';
                        statusIndicator.className = 'status offline';
                    }
                }

                setInterval(fetchLogs, 2000);
                fetchLogs();
            </script>
        </body>
    </html>
    `;
    res.send(html);
});

// ============================================================
// ============================================================
// RUTE 8: GET /api/force-sync  [MANUAL TRIGGER]
// ============================================================
router.get('/api/force-sync', (req, res) => {
    res.json({ status: 'ok', message: 'Sinkronisasi paksa (Samehadaku, Otakudesu, Kuronime & Unified DB) sedang dijalankan di latar belakang. Proses ini memakan waktu beberapa menit.' });

    // Jalankan asinkron tanpa memblokir request
    Promise.all([
        import('../sync/otaku_sync.js'),
        import('../sync/kuronime_sync.js')
    ]).then(([ { syncOtakudesu }, { syncKuronime } ]) => {
        Promise.all([
            runSync(true),
            syncOtakudesu(),
            syncKuronime()
        ]).then(() => {
            console.log('[ForceSync] Raw Sync selesai. Memulai Unified Sync...');
            return syncUnified();
        }).catch(err => console.error('[ForceSync] Error:', err.message));
    });
});

// ============================================================
// RUTE 8.5: GET /api/retry-enrich  [RETRY FAILED TMDB ENRICHMENT]
// ============================================================
router.get('/api/retry-enrich', async (req, res) => {
    try {
        const Anime = (await import('../models/Anime.js')).default;
        
        // Cari anime yang sudah "diperkaya" tapi datanya masih jelek/kosong
        const result = await Anime.updateMany(
            { 
                tmdbEnriched: true, 
                $or: [
                    { score: '-' },
                    { image: { $regex: /placehold/i } },
                    { image: null },
                    { image: '' }
                ]
            },
            { $set: { tmdbEnriched: false } }
        );

        res.json({ 
            status: 'ok', 
            message: `Berhasil mereset status tmdbEnriched untuk ${result.modifiedCount} anime. Proses Unified Sync sedang dijalankan di latar belakang untuk mencoba ulang pencarian TMDB.` 
        });

        // Jalankan ulang pekerja enrichment
        console.log(`[RetryEnrich] Mereset ${result.modifiedCount} anime. Memulai ulang Unified Sync...`);
        syncUnified().catch(err => console.error('[RetryEnrich] Error:', err.message));

    } catch (error) {
        console.error('[RetryEnrich] Gagal:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// RUTE 9: GET /api/factory-reset  [HARD RESET DB]
// ============================================================
router.get('/api/factory-reset', async (req, res) => {
    try {
        const Anime = (await import('../models/Anime.js')).default;
        const TMDBCache = (await import('../models/TMDBCache.js')).default;
        
        await Anime.deleteMany({});
        await TMDBCache.deleteMany({});

        // Bersihkan cache memori agar sistem tidak memakai data lama
        if (global.anime_db_cache) global.anime_db_cache = null;
        if (global.otaku_db_cache) global.otaku_db_cache = null;
        
        const { syncOtakudesu } = await import('../sync/otaku_sync.js');
        const { syncKuronime } = await import('../sync/kuronime_sync.js');

        res.json({ status: 'ok', message: 'BERHASIL! Semua Database MongoDB (Anime & TMDB Cache) telah DIHANCURKAN. Memulai scraping total dari titik nol...' });

        Promise.all([
            runSync(true),
            syncOtakudesu(),
            syncKuronime()
        ]).then(() => {
            console.log('[FactoryReset] Raw Sync selesai. Memulai Unified Sync...');
            return syncUnified();
        }).catch(err => console.error('[FactoryReset] Error:', err.message));

    } catch (error) {
        console.error('[FactoryReset] Gagal:', error.message);
        res.status(500).json({ error: error.message });
    }
});

export default router;
