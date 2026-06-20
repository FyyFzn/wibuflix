/**
 * Utilitas untuk pemrosesan string dan pencocokan teks (Fuzzy Matching).
 */

/**
 * Menormalkan judul anime agar mudah dicocokkan antar-scraper.
 * Contoh: "Kimetsu no Yaiba Season 3: Katanakaji no Sato-hen Sub Indo"
 * Menjadi: "kimetsu no yaiba s3 katanakaji no sato hen"
 */
export function normalizeTitleForMatch(title) {
    if (!title) return '';
    let t = title.toLowerCase();
    
    // Konversi ordinal: "2nd season" -> "season 2"
    t = t.replace(/(\d+)(?:st|nd|rd|th)\s+season/gi, 'season $1');
    
    // Hapus embel-embel umum
    t = t.replace(/subtitle indonesia|sub indo|batch|ongoing|on-going|tv series/gi, '');
    
    // Standarisasi "Season X" menjadi "sX"
    t = t.replace(/season\s*(\d+)/gi, 's$1');
    t = t.replace(/part\s*(\d+)/gi, 'p$1');
    
    // Hapus karakter spesial dan tanda baca
    t = t.replace(/[^\w\s]/g, ' ');
    
    // Hapus spasi ganda
    return t.replace(/\s+/g, ' ').trim();
}

/**
 * Menghitung tingkat kemiripan dua string menggunakan algoritma Sørensen–Dice coefficient.
 * Mengembalikan nilai antara 0.0 (tidak mirip sama sekali) hingga 1.0 (identik).
 */
export function diceCoefficient(str1, str2) {
    const s1 = str1.toLowerCase().replace(/\s+/g, '');
    const s2 = str2.toLowerCase().replace(/\s+/g, '');
    
    if (s1 === s2) return 1.0;
    if (s1.length < 2 || s2.length < 2) return 0.0;
    
    // Buat bigrams (pasangan 2 huruf berurutan)
    const bigrams1 = new Map();
    for (let i = 0; i < s1.length - 1; i++) {
        const bigram = s1.substring(i, i + 2);
        bigrams1.set(bigram, (bigrams1.get(bigram) || 0) + 1);
    }
    
    let intersectionSize = 0;
    for (let i = 0; i < s2.length - 1; i++) {
        const bigram = s2.substring(i, i + 2);
        const count = bigrams1.get(bigram);
        
        if (count > 0) {
            bigrams1.set(bigram, count - 1);
            intersectionSize++;
        }
    }
    
    return (2.0 * intersectionSize) / (s1.length - 1 + s2.length - 1);
}

/**
 * Mengekstrak informasi angka dari Season dan Part untuk mencegah kesalahan penggabungan.
 * Mengembalikan objek: { season: number | null, part: number | null }
 */
export function extractSeasonAndPart(title) {
    if (!title) return { season: null, part: null };
    
    let t = title.toLowerCase();
    // Konversi ordinal: "2nd season" -> "season 2"
    t = t.replace(/(\d+)(?:st|nd|rd|th)\s+season/gi, 'season $1');
    
    let season = null;
    let part = null;
    
    const seasonMatch = t.match(/(?:season|s)\s*(\d+)/i);
    if (seasonMatch) {
        season = parseInt(seasonMatch[1]);
    } else {
        // Fallback untuk angka Romawi di akhir kata (Cth: "Anime Title II")
        const romanMatch = t.match(/\b(ii|iii|iv|v|vi|vii|viii|ix|x)\b\s*$/i);
        if (romanMatch) {
            const romanMap = { 'ii': 2, 'iii': 3, 'iv': 4, 'v': 5, 'vi': 6, 'vii': 7, 'viii': 8, 'ix': 9, 'x': 10 };
            season = romanMap[romanMatch[1].toLowerCase()];
        }
    }
    
    const partMatch = t.match(/(?:part|p|cour)\s*(\d+)/i);
    if (partMatch) part = parseInt(partMatch[1]);
    
    return { season, part };
}

/**
 * Validasi ekstra apakah dua anime aman untuk digabungkan.
 */
export function isSafeToMerge(title1, title2, scoreThreshold = 0.85) {
    const norm1 = normalizeTitleForMatch(title1);
    const norm2 = normalizeTitleForMatch(title2);
    
    let score = diceCoefficient(norm1, norm2);
    
    // Penalti jika selisih kata signifikan (Cth: "Naruto" vs "Naruto Shippuden", "Anime" vs "Anime Specials")
    const words1 = norm1.split(' ');
    const words2 = norm2.split(' ');
    if (Math.abs(words1.length - words2.length) >= 1 && score > 0.7 && score < 1.0) {
        score -= 0.12; // Kurangi kemiripan agar tidak lolos ambang batas 0.85
    }
    
    if (score < scoreThreshold) return { isSafe: false, score };
    
    // Jangan gabungkan Movie dengan non-Movie
    const isMovie1 = title1.toLowerCase().includes('movie');
    const isMovie2 = title2.toLowerCase().includes('movie');
    if (isMovie1 !== isMovie2) return { isSafe: false, score };
    
    // Validasi ketat angka Season dan Part
    const meta1 = extractSeasonAndPart(title1);
    const meta2 = extractSeasonAndPart(title2);
    
    if (meta1.season !== null && meta2.season !== null && meta1.season !== meta2.season) {
        return { isSafe: false, score }; // Berbeda Season
    }
    
    if (meta1.part !== null && meta2.part !== null && meta1.part !== meta2.part) {
        return { isSafe: false, score }; // Berbeda Part
    }
    
    // Jika satu punya Part tapi yang lain tidak, asumsikan yang tidak punya adalah Part 1
    if (meta1.part === null && meta2.part !== null && meta2.part !== 1) return { isSafe: false, score };
    if (meta2.part === null && meta1.part !== null && meta1.part !== 1) return { isSafe: false, score };
    
    // Jika satu punya Season tapi yang lain tidak, asumsikan yang tidak punya adalah Season 1
    if (meta1.season === null && meta2.season !== null && meta2.season !== 1) return { isSafe: false, score };
    if (meta2.season === null && meta1.season !== null && meta1.season !== 1) return { isSafe: false, score };
    
    return { isSafe: true, score };
}

export function formatEpisodeTitle(title) {
    if (!title) return 'Episode ?';
    if (title.toLowerCase().includes('batch')) return 'Batch';
    const typeMatch = title.match(/(OVA|OAD|Special|SP)\s*(\d+(\.\d+)?)/i);
    if (typeMatch) return `${typeMatch[1].toUpperCase()} ${typeMatch[2]}`;
    const epMatch = title.match(/(?:episode|ep|eps)\s*(\d+(?:\.\d+)?)/i);
    if (epMatch) return `Episode ${epMatch[1]}`;
    const fallback = title.match(/\b(\d+(\.\d+)?)\s*(?:\(End\))?\s*$/i);
    if (fallback) return `Episode ${fallback[1]}`;
    return title;
}

export function extractEpNumStrict(title) {
    if (!title) return null;
    const stdMatch = title.match(/(?:episode|eps|ep)\s*(\d+(\.\d+)?)/i);
    if (stdMatch) return parseFloat(stdMatch[1]);
    const ovaMatch = title.match(/(?:OVA|Special|SP)\s*(\d+(\.\d+)?)/i);
    if (ovaMatch) return parseFloat(ovaMatch[1]);
    const fallbackMatch = title.match(/\b(\d+(\.\d+)?)\s*(?:\(End\))?\s*$/i);
    if (fallbackMatch) return parseFloat(fallbackMatch[1]);
    return null;
}

export function extractEpNum(title) {
    if (!title) return title;
    const epMatch = title.match(/(?:episode|ep|eps)\s*0*(\d+(?:\.\d+)?)/i);
    if (epMatch) return parseFloat(epMatch[1]);
    const pureNumMatch = title.match(/^\s*0*(\d+(?:\.\d+)?)\s*$/);
    if (pureNumMatch) return parseFloat(pureNumMatch[1]);
    return title;
}

export function adjustTitleEpisodeNumber(title, offset) {
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
}