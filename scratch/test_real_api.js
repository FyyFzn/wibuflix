import { initPagePool } from '../src/puppeteer/pool.js';
import { getEpisodes } from '../src/scraper/episodes.js';
import * as otakudesu from '../src/scraper/otakudesu_controller.js';

const extractEpNum = (title) => {
    const match = title.match(/(?:episode|ep|eps)\s*(\d+(?:\.\d+)?)/i) || title.match(/(\d+(?:\.\d+)?)/);
    return match ? parseFloat(match[1]) : title;
};

const adjustTitleEpisodeNumber = (title, offset) => {
    if (!offset) return title;
    const match = title.match(/(?:episode|ep|eps)\s*(\d+(?:\.\d+)?)/i) || title.match(/(\d+(?:\.\d+)?)/);
    if (match) {
        const originalNumStr = match[1];
        const originalNum = parseFloat(originalNumStr);
        const newNum = originalNum + offset;
        
        const zeroPaddingLength = originalNumStr.startsWith('0') && originalNumStr.length > 1 ? originalNumStr.length : 0;
        let newNumStr = String(newNum);
        if (zeroPaddingLength > 0) {
            newNumStr = newNumStr.padStart(zeroPaddingLength, '0');
        }
        
        const fullMatch = match[0];
        const updatedFullMatch = fullMatch.replace(originalNumStr, newNumStr);
        return title.replace(fullMatch, updatedFullMatch);
    }
    return title;
};

async function testReal() {
    console.log("Initializing page pool...");
    await initPagePool();
    console.log("Page pool initialized.");

    const urlSamehadaku = "https://v2.samehadaku.how/anime/dr-stone-season-3-part-2/";
    const otakuSlug = "drstne-s3-p2-sub-indo";

    console.log(`Fetching Samehadaku: ${urlSamehadaku}`);
    let sameRes = null;
    try {
        sameRes = await getEpisodes(urlSamehadaku);
        console.log(`Samehadaku fetched successfully: ${sameRes.daftar_episode.length} episodes.`);
    } catch (e) {
        console.error("Failed to fetch Samehadaku:", e.message);
    }

    console.log(`Fetching Otakudesu: ${otakuSlug}`);
    let otakuRes = null;
    try {
        otakuRes = await otakudesu.getOtakuEpisodesFormatted(otakuSlug);
        console.log(`Otakudesu fetched successfully: ${otakuRes.daftar_episode.length} episodes.`);
    } catch (e) {
        console.error("Failed to fetch Otakudesu:", e.message);
    }

    if (!sameRes || !otakuRes) {
        console.log("Could not perform merge test due to fetch failure.");
        process.exit(1);
    }

    // Format merge
    const data = {
        judul_seri: sameRes.judul_seri || otakuRes.judul_seri || 'Unknown',
        daftar_episode: []
    };
    
    // --- DETEKSI OFFSET OTOMATIS ---
    let offsetSame = 0;
    let offsetOtaku = 0;

    const getValidEpNums = (epsList) => {
        if (!epsList) return [];
        return epsList
            .filter(ep => !ep.judul.toLowerCase().includes('batch'))
            .map(ep => extractEpNum(ep.judul))
            .filter(num => typeof num === 'number' && !isNaN(num));
    };

    const sameEps = getValidEpNums(sameRes?.daftar_episode);
    const otakuEps = getValidEpNums(otakuRes?.daftar_episode);

    if (sameEps.length > 0 && otakuEps.length > 0) {
        const minSame = Math.min(...sameEps);
        const minOtaku = Math.min(...otakuEps);

        console.log(`Samehadaku min episode: ${minSame}`);
        console.log(`Otakudesu min episode: ${minOtaku}`);

        const sameSet = new Set(sameEps);
        const hasOverlap = otakuEps.some(num => sameSet.has(num));

        if (!hasOverlap) {
            if (minOtaku === 1 && minSame > 1) {
                offsetOtaku = minSame - 1;
            } else if (minSame === 1 && minOtaku > 1) {
                offsetSame = minOtaku - 1;
            }
        }
    }

    console.log(`Detected Offsets - Samehadaku: ${offsetSame}, Otakudesu: ${offsetOtaku}`);

    const epMap = new Map();

    if (sameRes && sameRes.daftar_episode) {
        sameRes.daftar_episode.forEach(ep => {
            if (ep.judul.toLowerCase().includes('batch')) return;
            const rawNum = extractEpNum(ep.judul);
            const num = typeof rawNum === 'number' ? rawNum + offsetSame : rawNum;
            const adjustedJudul = typeof rawNum === 'number' ? adjustTitleEpisodeNumber(ep.judul, offsetSame) : ep.judul;
            
            epMap.set(num, {
                judul: adjustedJudul,
                tanggal: ep.tanggal,
                urls: { samehadaku: ep.url }
            });
        });
    }
    
    if (otakuRes && otakuRes.daftar_episode) {
        otakuRes.daftar_episode.forEach(ep => {
            if (ep.judul.toLowerCase().includes('batch')) return;
            const rawNum = extractEpNum(ep.judul);
            const num = typeof rawNum === 'number' ? rawNum + offsetOtaku : rawNum;
            
            if (epMap.has(num)) {
                const existing = epMap.get(num);
                existing.urls.otakudesu = ep.url;
            } else {
                const adjustedJudul = typeof rawNum === 'number' ? adjustTitleEpisodeNumber(ep.judul, offsetOtaku) : ep.judul;
                epMap.set(num, {
                    judul: adjustedJudul,
                    tanggal: ep.tanggal,
                    urls: { otakudesu: ep.url }
                });
            }
        });
    }
    
    const mergedEps = Array.from(epMap.values());
    mergedEps.sort((a, b) => {
        const numA = extractEpNum(a.judul);
        const numB = extractEpNum(b.judul);
        if (typeof numA === 'number' && typeof numB === 'number') return numB - numA;
        return 0;
    });

    data.daftar_episode = mergedEps;
    console.log("Merged episodes sample (first 5):");
    console.log(JSON.stringify(data.daftar_episode.slice(0, 5), null, 2));

    process.exit(0);
}

testReal();
