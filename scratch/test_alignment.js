const extractEpNum = (title) => {
    const match = title.match(/(?:episode|ep|eps)\s*0*(\d+(?:\.\d+)?)/i) || title.match(/0*(\d+(?:\.\d+)?)/);
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

const getValidEpNums = (epsList) => {
    if (!epsList) return [];
    return epsList
        .filter(ep => !ep.judul.toLowerCase().includes('batch'))
        .map(ep => extractEpNum(ep.judul))
        .filter(num => typeof num === 'number' && !isNaN(num));
};

function testMerge(sameRes, otakuRes) {
    let offsetSame = 0;
    let offsetOtaku = 0;

    const sameEps = getValidEpNums(sameRes?.daftar_episode);
    const otakuEps = getValidEpNums(otakuRes?.daftar_episode);

    if (sameEps.length > 0 && otakuEps.length > 0) {
        const minSame = Math.min(...sameEps);
        const minOtaku = Math.min(...otakuEps);

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

    console.log(`Offsets - Samehadaku: ${offsetSame}, Otakudesu: ${offsetOtaku}`);

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

    return mergedEps;
}

// Test Case 1: Dr. Stone S3 Part 2
// Samehadaku: Start from 13, up to 15
// Otakudesu: Start from 1, up to 3
const mockSame1 = {
    daftar_episode: [
        { judul: "Dr. Stone Season 3 Part 2 Episode 15 Sub Indo", url: "url-same-15", tanggal: "2023-10-14" },
        { judul: "Dr. Stone Season 3 Part 2 Episode 14 Sub Indo", url: "url-same-14", tanggal: "2023-10-07" },
        { judul: "Dr. Stone Season 3 Part 2 Episode 13 Sub Indo", url: "url-same-13", tanggal: "2023-09-30" }
    ]
};

const mockOtaku1 = {
    daftar_episode: [
        { judul: "Dr. Stone S3 Part 2 Episode 03 Sub Indo", url: "url-otaku-3", tanggal: "2023-10-14" },
        { judul: "Dr. Stone S3 Part 2 Episode 02 Sub Indo", url: "url-otaku-2", tanggal: "2023-10-07" },
        { judul: "Dr. Stone S3 Part 2 Episode 01 Sub Indo", url: "url-otaku-1", tanggal: "2023-09-30" }
    ]
};

console.log("--- TEST CASE 1 ---");
const res1 = testMerge(mockSame1, mockOtaku1);
console.log(JSON.stringify(res1, null, 2));

// Test Case 2: Otakudesu has newer episode 04
const mockOtaku2 = {
    daftar_episode: [
        { judul: "Dr. Stone S3 Part 2 Episode 04 Sub Indo", url: "url-otaku-4", tanggal: "2023-10-21" },
        { judul: "Dr. Stone S3 Part 2 Episode 03 Sub Indo", url: "url-otaku-3", tanggal: "2023-10-14" },
        { judul: "Dr. Stone S3 Part 2 Episode 02 Sub Indo", url: "url-otaku-2", tanggal: "2023-10-07" },
        { judul: "Dr. Stone S3 Part 2 Episode 01 Sub Indo", url: "url-otaku-1", tanggal: "2023-09-30" }
    ]
};

console.log("\n--- TEST CASE 2 ---");
const res2 = testMerge(mockSame1, mockOtaku2);
console.log(JSON.stringify(res2, null, 2));

// Test Case 3: Overlapping episodes (normal)
const mockSame3 = {
    daftar_episode: [
        { judul: "Anime Episode 3 Sub Indo", url: "url-same-3", tanggal: "2023-10-14" },
        { judul: "Anime Episode 2 Sub Indo", url: "url-same-2", tanggal: "2023-10-07" },
        { judul: "Anime Episode 1 Sub Indo", url: "url-same-1", tanggal: "2023-09-30" }
    ]
};
const mockOtaku3 = {
    daftar_episode: [
        { judul: "Anime Episode 2 Sub Indo", url: "url-otaku-2", tanggal: "2023-10-07" },
        { judul: "Anime Episode 1 Sub Indo", url: "url-otaku-1", tanggal: "2023-09-30" }
    ]
};

console.log("\n--- TEST CASE 3 ---");
const res3 = testMerge(mockSame3, mockOtaku3);
console.log(JSON.stringify(res3, null, 2));
