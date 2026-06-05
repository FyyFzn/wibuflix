const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../otakudesu_db.json');

async function syncOtakudesu() {
    console.log('[OtakuSync] Memulai sinkronisasi katalog Otakudesu...');
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
                // Ekstrak slug
                // contoh: https://otakudesu.blog/anime/compass-20-sub-indo/
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
            fs.writeFileSync(DB_PATH, JSON.stringify(list, null, 2));
            console.log(`[OtakuSync] Berhasil menyimpan ${list.length} anime ke otakudesu_db.json`);
        } else {
            console.log('[OtakuSync] Gagal: Tidak ada anime yang ditemukan.');
        }

    } catch (err) {
        console.error('[OtakuSync] Error:', err.message);
    }
}

// Jika dijalankan langsung
if (require.main === module) {
    syncOtakudesu();
}

module.exports = { syncOtakudesu };
