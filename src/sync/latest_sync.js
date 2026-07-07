import * as cheerio from 'cheerio';
import axios from 'axios';
import { fetchWithCF } from '../utils/scrapeHelper.js';
import { releaseToPool } from '../puppeteer/pool.js';
import Anime from '../models/Anime.js';
import { fetchNanimeInertia } from '../controllers/nanimeController.js';

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
    log(`[Latest Sync] Memulai Fast-Sync Beranda Samehadaku & Otakudesu...`);
    log(`===========================================\n`);

    try {
        await scrapeSamehadakuLatest();
        await scrapeOtakudesuLatest();
        await scrapeKuronimeLatest();
        await scrapeNanimeLatest();
        await scrapeNimegamiLatest();
    } catch (e) {
        console.error(`[Latest Sync] Error fatal:`, e.message);
    } finally {
        isLatestSyncing = false;
        log(`[Latest Sync] Selesai.\n`);
    }
}

async function scrapeSamehadakuLatest() {
    const url = `https://v2.samehadaku.how/`;
    log(`[Latest Sync] Mengakses Beranda Samehadaku...`);

    let fetchRes, slot;
    const updates = [];
    try {
        fetchRes = await fetchWithCF(url, { timeout: 60000, fetchTimeout: 10000 });
        slot = fetchRes?.slot;
        
        if (!fetchRes || fetchRes.html === '404_NOT_FOUND' || !fetchRes.html) {
            log(`[Latest Sync] Gagal mendapatkan HTML Samehadaku.`);
            return;
        }

        const $ = fetchRes.$;

        // Mencari di bagian "Post Show" atau elemen animepost terbaru di beranda
        $('.post-show ul li, .animepost').each((_, el) => {
            const titleNode = $(el).find('.title, .entry-title, .tt h2').first();
            const epNode = $(el).find('author[itemprop="name"], .epx').first();
            
            if (titleNode.length && epNode.length) {
                const judul = titleNode.text().trim();
                const epsText = epNode.text().trim();
                
                // Format eps jika perlu (contoh: "12" menjadi "Eps 12")
                const finalStatus = epsText.toLowerCase().includes('eps') ? epsText : `Eps ${epsText}`;

                updates.push({ judul, status: finalStatus });
            }
        });
    } catch (e) {
        console.error(`[Latest Sync] Gagal memuat Samehadaku:`, e.message);
        return;
    } finally {
        if (slot) releaseToPool(slot);
    }

    if (updates.length > 0) {
        log(`[Latest Sync] Ditemukan ${updates.length} anime terupdate. Melakukan sinkronisasi ke MongoDB...`);
        
        const { normalizeTitleForMatch } = await import('../utils/stringUtils.js');
        const bulkOps = updates.map(anime => {
            const normTitle = normalizeTitleForMatch(anime.judul);
            return {
                updateOne: {
                    filter: { normalizedTitle: normTitle },
                    update: { $set: { status: anime.status } }
                }
            };
        });

        const result = await Anime.bulkWrite(bulkOps);
        log(`[Latest Sync] ✅ Samehadaku: Berhasil mengupdate status ${result.modifiedCount} anime.`);
    } else {
        log(`[Latest Sync] Tidak ada elemen update yang terdeteksi di Samehadaku.`);
    }
}

async function scrapeOtakudesuLatest() {
    const url = `https://otakudesu.blog/`;
    log(`[Latest Sync] Mengakses Beranda Otakudesu...`);

    let fetchRes, slot;
    const updates = [];
    try {
        fetchRes = await fetchWithCF(url, { timeout: 60000, fetchTimeout: 10000 });
        slot = fetchRes?.slot;
        
        if (!fetchRes || fetchRes.html === '404_NOT_FOUND' || !fetchRes.html) {
            log(`[Latest Sync] Gagal mendapatkan HTML Otakudesu.`);
            return;
        }

        const $ = fetchRes.$;

        $('.venz ul li').each((_, el) => {
            const title = $(el).find('.jdlflm').text().trim();
            const ep = $(el).find('.epz').text().trim();
            
            if (title && ep) {
                updates.push({ title, status: ep });
            }
        });
    } catch (e) {
        console.error(`[Latest Sync] Gagal memuat Otakudesu:`, e.message);
        return;
    } finally {
        if (slot) releaseToPool(slot);
    }

    if (updates.length > 0) {
        log(`[Latest Sync] Ditemukan ${updates.length} anime terupdate di Otakudesu. Melakukan sinkronisasi ke MongoDB...`);
        
        const { normalizeTitleForMatch } = await import('../utils/stringUtils.js');
        const now = Date.now();
        const bulkOps = updates.map((anime, index) => {
            const normTitle = normalizeTitleForMatch(anime.title);
            return {
                updateOne: {
                    filter: { normalizedTitle: normTitle },
                    update: { 
                        $set: { 
                            status: anime.status,
                            lastUpdated: new Date(now - index * 1000)
                        } 
                    }
                }
            };
        });

        const result = await Anime.bulkWrite(bulkOps);
        log(`[Latest Sync] ✅ Otakudesu: Berhasil mengupdate status ${result.modifiedCount} anime.`);
    } else {
        log(`[Latest Sync] Tidak ada elemen update yang terdeteksi di Otakudesu.`);
    }
}

async function scrapeKuronimeLatest() {
    const url = `https://kuronime.sbs/`;
    log(`[Latest Sync] Mengakses Beranda Kuronime...`);

    let fetchRes, slot;
    const updates = [];
    try {
        fetchRes = await fetchWithCF(url, { timeout: 60000, fetchTimeout: 10000 });
        slot = fetchRes?.slot;
        
        if (!fetchRes || fetchRes.html === '404_NOT_FOUND' || !fetchRes.html) {
            log(`[Latest Sync] Gagal mendapatkan HTML Kuronime.`);
            return;
        }

        const $ = fetchRes.$;
        const seenUrls = new Set();

        // Hanya ambil section "New Episodes" pertama, bukan "Top Episodes Of The Week"
        $('.bixbox').first().find('article.bsu').each((_, el) => {
            const title = $(el).find('.bsuxtt h2').text().trim();
            const ep = $(el).find('.bt .ep').text().trim();
            const href = $(el).find('a').attr('href');

            if (title && ep && href && !seenUrls.has(href)) {
                seenUrls.add(href);
                updates.push({ title, status: ep });
            }
        });
    } catch (e) {
        console.error(`[Latest Sync] Gagal memuat Kuronime:`, e.message);
        return;
    } finally {
        if (slot) releaseToPool(slot);
    }

    if (updates.length > 0) {
        log(`[Latest Sync] Ditemukan ${updates.length} anime terupdate di Kuronime.`);

        const { normalizeTitleForMatch } = await import('../utils/stringUtils.js');
        const now = Date.now();
        const bulkOps = updates.map((anime, index) => {
            const normTitle = normalizeTitleForMatch(anime.title);
            return {
                updateOne: {
                    filter: { normalizedTitle: normTitle },
                    update: {
                        $set: {
                            status: anime.status,
                            lastUpdated: new Date(now - index * 1000)
                        }
                    }
                    // Tidak pakai upsert — hanya update yang sudah ada di database
                }
            };
        });

        const result = await Anime.bulkWrite(bulkOps);
        log(`[Latest Sync] ✅ Kuronime: Berhasil mengupdate status ${result.modifiedCount} anime.`);
    } else {
        log(`[Latest Sync] Tidak ada elemen update yang terdeteksi di Kuronime.`);
    }
}

async function scrapeNanimeLatest() {
    const url = `https://nanimeid.net/`;
    log(`[Latest Sync] Mengakses Beranda Nanime ID (Inertia JSON)...`);

    const updates = [];
    try {
        const data = await fetchNanimeInertia(url);
        const props = data?.props || {};
        // PENTING: HANYA baca properti yang secara spesifik menampung UPDATE TERBARU (Latest/Recent Updates).
        // JANGAN PERNAH memasukkan properti seperti popular, popularAnimes, popular_ongoing, trending, top, atau ongoing!
        const latestList = props.latestUpdates || props.latest_episodes || props.recent_episodes || props.latest_series || props.latest || props.updates || props.recent || props.new_episodes || [];

        for (const item of latestList) {
            // PROTEKSI ANTI-POPULAR & ANTI-LAMPAU:
            // 1. Pastikan item ini adalah update episode baru, bukan kartu anime populer statis!
            const epNumRaw = item.number || item.episode || item.episode_number || item.ep || (item.latest_episode ? item.latest_episode.number : null);
            const isEpisodeUpdate = (epNumRaw !== undefined && epNumRaw !== null && epNumRaw !== '') || item.anime !== undefined || item.series !== undefined || (item.title && typeof item.title === 'string' && item.title.toLowerCase().includes('episode'));
            
            if (!isEpisodeUpdate) {
                continue;
            }

            // 2. Proteksi Waktu (Stale Update Protection):
            // Kartu di section Anime Populer sering memiliki label seperti "12 hari lalu", "24 hari lalu", atau "3 minggu lalu".
            // Jika update sudah lebih dari 3 hari lalu atau berminggu-minggu/berbulan-bulan lalu, LEWATI!
            // Jangan biarkan anime lama menimpa lastUpdated menjadi hari ini dan merusak urutan beranda WibuFlix.
            const timeStr = (item.time_ago || item.diff_for_humans || item.date || item.time || item.created_at || item.updated_at || '').toString().toLowerCase();
            if (timeStr.includes('minggu') || timeStr.includes('bulan') || timeStr.includes('tahun')) {
                continue;
            }
            if (timeStr.includes('hari')) {
                const matchDays = timeStr.match(/(\d+)\s*hari/);
                if (matchDays && parseInt(matchDays[1], 10) >= 3) {
                    continue;
                }
            }

            const animeObj = item.anime || item.series || item.show || item;
            
            // 3-Layer Structural Protection (Anti-Comic)
            const rawType = (animeObj.type || item.type || '').toString().toUpperCase();
            const comicTypes = ['MANGA', 'MANHWA', 'MANHUA', 'COMIC', 'NOVEL', 'DOUJIN', 'ONE-SHOT'];
            if (comicTypes.includes(rawType) || animeObj.chapters !== undefined || item.chapters !== undefined) {
                continue;
            }

            const title = animeObj.title || animeObj.name || item.title || item.name;
            const slug = animeObj.slug || item.slug || item.url || '';
            if (!title) continue;
            if (slug && (slug.includes('/manga/') || slug.includes('/read/'))) continue;

            let statusText = typeof epNumRaw === 'number' || /^\d+$/.test(epNumRaw) ? `Eps ${epNumRaw}` : (item.status || item.title || `Eps ${epNumRaw}`);
            if (!statusText.toLowerCase().includes('eps')) {
                statusText = `Eps ${epNumRaw || '-'}`;
            }

            updates.push({ title: title.trim(), status: statusText });
        }
    } catch (e) {
        console.error(`[Latest Sync] Gagal memuat Nanime ID:`, e.message);
        return;
    }

    if (updates.length > 0) {
        log(`[Latest Sync] Ditemukan ${updates.length} anime terupdate di Nanime ID. Melakukan sinkronisasi ke MongoDB...`);

        const { normalizeTitleForMatch } = await import('../utils/stringUtils.js');
        const now = Date.now();
        const bulkOps = updates.map((anime, index) => {
            const normTitle = normalizeTitleForMatch(anime.title);
            return {
                updateOne: {
                    filter: { normalizedTitle: normTitle },
                    update: {
                        $set: {
                            status: anime.status,
                            lastUpdated: new Date(now - index * 1000)
                        }
                    }
                }
            };
        });

        const result = await Anime.bulkWrite(bulkOps);
        log(`[Latest Sync] ✅ Nanime ID: Berhasil mengupdate status ${result.modifiedCount} anime.`);
    } else {
        log(`[Latest Sync] Tidak ada elemen update yang terdeteksi di Nanime ID.`);
    }
}

async function scrapeNimegamiLatest() {
    const url = `https://nimegami.id/anime-terbaru-sub-indo/`;
    log(`[Latest Sync] Mengakses Beranda Nimegami...`);

    let fetchRes, slot;
    const updatesMap = new Map();
    try {
        fetchRes = await fetchWithCF(url, { timeout: 60000, fetchTimeout: 10000 });
        slot = fetchRes?.slot;
        
        if (!fetchRes || fetchRes.html === '404_NOT_FOUND' || !fetchRes.html) {
            log(`[Latest Sync] Gagal mendapatkan HTML Nimegami.`);
            return;
        }

        const $ = fetchRes.$;
        const ignoreWords = ['/category/', '/tag/', '/list', '/jadwal', '/genre', 'wp-content', 'javascript:', 'telegram', 'facebook', 'twitter', 'instagram', 'discord'];

        $('a').each((_, el) => {
            const href = $(el).attr('href');
            let text = $(el).text().replace(/\s+/g, ' ').trim();
            if (!href || !href.startsWith('http') || ignoreWords.some(w => href.toLowerCase().includes(w)) || href === 'https://nimegami.id/') return;

            if (href.includes('nimegami.id/')) {
                if (!updatesMap.has(href)) {
                    updatesMap.set(href, { title: null, status: null });
                }
                const entry = updatesMap.get(href);
                if (/eps?\.?\s*\d+/i.test(text)) {
                    const match = text.match(/eps?\.?\s*(\d+)/i);
                    if (match) entry.status = `Eps ${match[1]}`;
                } else if (text.length > 2 && !text.toLowerCase().includes('belum update')) {
                    entry.title = text
                        .replace(/\s*\(Complete\)\s*/i, '')
                        .replace(/\s*\(On-?going\)\s*/i, '')
                        .replace(/\s*Subtitle\s*Indonesia\s*/i, '')
                        .replace(/\s*Sub\s*Indo\s*/i, '')
                        .trim();
                }
            }
        });
    } catch (e) {
        console.error(`[Latest Sync] Gagal memuat Nimegami:`, e.message);
        return;
    } finally {
        if (slot) releaseToPool(slot);
    }

    const updates = [];
    for (const [url, data] of updatesMap.entries()) {
        if (data.title && data.status) {
            updates.push({ title: data.title, status: data.status, url });
        }
    }

    if (updates.length > 0) {
        log(`[Latest Sync] Ditemukan ${updates.length} anime terupdate di Nimegami. Melakukan sinkronisasi ke MongoDB...`);

        const { normalizeTitleForMatch } = await import('../utils/stringUtils.js');
        const now = Date.now();
        const bulkOps = updates.map((anime, index) => {
            const normTitle = normalizeTitleForMatch(anime.title);
            return {
                updateOne: {
                    filter: { $or: [{ normalizedTitle: normTitle }, { 'sources.nimegami.url': anime.url }] },
                    update: {
                        $set: {
                            status: anime.status,
                            'sources.nimegami.url': anime.url,
                            lastUpdated: new Date(now - index * 1000)
                        }
                    }
                }
            };
        });

        const result = await Anime.bulkWrite(bulkOps);
        log(`[Latest Sync] ✅ Nimegami: Berhasil mengupdate status ${result.modifiedCount} anime.`);
    } else {
        log(`[Latest Sync] Tidak ada elemen update yang terdeteksi di Nimegami.`);
    }
}



