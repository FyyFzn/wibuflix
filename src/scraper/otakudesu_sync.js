const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.HOME ? path.join(process.env.HOME, 'data', 'otakudesu_db.json') : path.join(__dirname, '../../otakudesu_db.json');

const log = (...args) => {
    if (global.forceLog) {
        global.forceLog(...args);
    } else {
        console.log(...args);
    }
};

async function syncOtakudesu() {
    log('[OtakuSync] Memulai sinkronisasi katalog Otakudesu...');
    try {
        const { data } = await axios.get('https://otakudesu.blog/anime-list/', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 15000
        });

        const $ = cheerio.load(data);
        const list = [];
        
        $('.penzbar .jdlbar ul li a').each((_, el) => {
            const title = $(el).text().trim();
            const url = $(el).attr('href');
            if (title && url) {
                const parts = url.split('/').filter(Boolean);
                const slug = parts[parts.length - 1];
                
                list.push({
                    title: title,
                    url: url,
                    slug: slug,
                    id: `otakudesu:${slug}`
                });
            }
        });

        if (list.length > 0) {
            global.otakudesu_db_cache = list;
            const dbDir = path.dirname(DB_PATH);
            if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
            
            try {
                fs.writeFileSync(DB_PATH, JSON.stringify(list, null, 2));
                log(`[OtakuSync] Berhasil menyimpan ${list.length} anime ke database.`);
            } catch (fsErr) {
                log(`[OtakuSync] Gagal menyimpan ke disk. Tersimpan di memory cache. Error: ${fsErr.message}`);
            }
        } else {
            log('[OtakuSync] Peringatan: Tidak ada anime yang terambil dari list.');
        }

    } catch (err) {
        console.error('[OtakuSync] Error:', err.message);
    }
}

function loadOtakuDatabase() {
    if (global.otakudesu_db_cache) return global.otakudesu_db_cache;
    
    if (fs.existsSync(DB_PATH)) {
        try {
            const raw = fs.readFileSync(DB_PATH, 'utf-8');
            global.otakudesu_db_cache = JSON.parse(raw);
            return global.otakudesu_db_cache;
        } catch(e) {
            console.error("[Otaku DB] Gagal membaca JSON:", e.message);
            return [];
        }
    }
    return [];
}

function startBackgroundOtakuSync() {
    // Jalankan segera saat start
    syncOtakudesu();

    // Jalankan ulang setiap 6 jam
    setInterval(() => {
        syncOtakudesu();
    }, 6 * 60 * 60 * 1000);
}

// Jika dijalankan langsung
if (require.main === module) {
    syncOtakudesu();
}

module.exports = { syncOtakudesu, loadOtakuDatabase, startBackgroundOtakuSync };
