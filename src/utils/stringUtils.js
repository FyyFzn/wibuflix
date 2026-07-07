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

    // Hapus franchise besar Tokusatsu agar string similarity tidak bias oleh prefix yang panjang
    t = t.replace(/(kamen rider|power rangers|ultraman|super sentai)\s*/gi, '');

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

import stringSimilarity from 'string-similarity';

/**
 * Menghitung tingkat kemiripan dua string menggunakan algoritma Sørensen–Dice coefficient.
 * Mengembalikan nilai antara 0.0 (tidak mirip sama sekali) hingga 1.0 (identik).
 */
export function diceCoefficient(str1, str2) {
    if (!str1 || !str2) return 0.0;
    return stringSimilarity.compareTwoStrings(str1, str2);
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

/**
 * Validasi ekstra khusus untuk peleburan berbasis ID (TMDB/AniList).
 * Mengabaikan kemiripan string (karena nama pendek vs nama panjang sering berbeda jauh),
 * HANYA memvalidasi bahwa mereka adalah Season, Part, dan Tipe (Movie/TV) yang sama.
 */
export function isSafeToMergeById(title1, title2) {
    // Jangan gabungkan Movie dengan non-Movie
    const isMovie1 = title1.toLowerCase().includes('movie');
    const isMovie2 = title2.toLowerCase().includes('movie');
    if (isMovie1 !== isMovie2) return false;

    // Validasi ketat angka Season dan Part
    const meta1 = extractSeasonAndPart(title1);
    const meta2 = extractSeasonAndPart(title2);

    if (meta1.season !== null && meta2.season !== null && meta1.season !== meta2.season) {
        return false; // Berbeda Season
    }

    if (meta1.part !== null && meta2.part !== null && meta1.part !== meta2.part) {
        return false; // Berbeda Part
    }

    // Jika satu punya Part tapi yang lain tidak, asumsikan yang tidak punya adalah Part 1
    if (meta1.part === null && meta2.part !== null && meta2.part !== 1) return false;
    if (meta2.part === null && meta1.part !== null && meta1.part !== 1) return false;

    // Jika satu punya Season tapi yang lain tidak, asumsikan yang tidak punya adalah Season 1
    if (meta1.season === null && meta2.season !== null && meta2.season !== 1) return false;
    if (meta2.season === null && meta1.season !== null && meta1.season !== 1) return false;

    return true;
}

export function formatEpisodeTitle(title) {
    if (!title) return 'Episode ?';
    if (title.toLowerCase().includes('batch')) return 'Batch';
    const typeMatch = title.match(/(OVA|OAD|Special|SP)[\s-_]*(\d+(\.\d+)?)/i);
    if (typeMatch) return `${typeMatch[1].toUpperCase()} ${typeMatch[2]}`;
    const epMatch = title.match(/(?:episode|ep|eps)[\s-_]*(\d+(?:\.\d+)?)/i);
    if (epMatch) return `Episode ${epMatch[1]}`;
    const fallback = title.match(/\b(\d+(\.\d+)?)\s*(?:\(End\))?\s*$/i);
    if (fallback) return `Episode ${fallback[1]}`;
    return title;
}

export function extractEpNumStrict(title) {
    if (!title) return null;
    const str = String(title).trim();
    
    // 1. Jika teks adalah murni MAL ID atau DB ID (misal: "mal-34443", "db-67890"), langsung abaikan!
    if (/^(mal-\d+|db-[a-f0-9]+)$/i.test(str)) return null;

    // 2. Bersihkan resolusi, ekstensi file, dan penanda kualitas agar tidak keliru terdeteksi
    let clean = str.replace(/\b(1080p|720p|480p|360p|240p|x264|x265|mkv|mp4|avi|bd|bluray|web-dl|aac|h264)\b/gi, ' ');
    clean = clean.replace(/\b(mal-\d+|db-[a-f0-9]+)\b/gi, ' ');

    // 3. Pola standar: Episode / Ep / Eps / E / OVA / Special / SP dengan fleksibel pemisah [\s-_]*
    const stdMatch = clean.match(/(?:episode|eps|ep|ova|special|sp)[\s-_]*0*(\d+(?:\.\d+)?)/i);
    if (stdMatch) return parseFloat(stdMatch[1]);

    // 4. Pola pemisah ganda khas Otakudesu / Fansub (misal: "Otakudesu_Baki--01_", "Baki - 01 -", "[01]", "-10-")
    const sepMatch = clean.match(/(?:--|__|-\s*|\s+-\s*|\[|\()[\s-_]*0*(\d+(?:\.\d+)?)(?:\b|\s|[-_\]\)\.]|$)/);
    if (sepMatch) {
        const num = parseFloat(sepMatch[1]);
        // Pastikan angka masuk akal sebagai nomor episode (bukan tahun rilis misal 2024)
        if (num < 1900 || num > 2100) return num;
    }

    // 5. Pola angka di akhir string (misal "Baki 01 (End)", "Baki 01")
    const fallbackMatch = clean.match(/\b0*(\d+(?:\.\d+)?)\s*(?:\(End\))?\s*$/i);
    if (fallbackMatch) {
        const num = parseFloat(fallbackMatch[1]);
        if (num < 1900 || num > 2100) return num;
    }

    return null;
}

export function extractEpNum(title) {
    if (!title) return title;
    const strictNum = extractEpNumStrict(title);
    if (strictNum !== null) return strictNum;
    const pureNumMatch = title.match(/^\s*0*(\d+(?:\.\d+)?)\s*$/);
    if (pureNumMatch) return parseFloat(pureNumMatch[1]);
    return title;
}

export function adjustTitleEpisodeNumber(title, offset) {
    if (!offset) return title;
    let match = title.match(/(?:episode|ep|eps)[\s-_]*(\d+(?:\.\d+)?)/i);
    let originalNumStr = match ? match[1] : null;

    if (!originalNumStr) {
        const epNum = extractEpNumStrict(title);
        if (epNum !== null) {
            const numRegex = new RegExp(`(?:^|\\s|-|_|\\[|\\()0*${epNum}(?:\\s|-|_|\\]|\\)|\\.|$)`, 'i');
            if (numRegex.test(title)) {
                originalNumStr = String(epNum);
            }
        }
    }

    if (originalNumStr) {
        const originalNum = parseFloat(originalNumStr);
        const newNum = originalNum + offset;
        const zeroPaddingLength = originalNumStr.startsWith('0') && originalNumStr.length > 1 ? originalNumStr.length : 0;
        let newNumStr = String(newNum);
        if (zeroPaddingLength > 0) {
            newNumStr = newNumStr.padStart(zeroPaddingLength, '0');
        }
        const regexReplace = new RegExp(`((?:episode|ep|eps)[\\s-_]*0*)${originalNumStr}\\b`, 'i');
        if (regexReplace.test(title)) {
            return title.replace(regexReplace, `$1${newNumStr}`);
        } else {
            const fallbackReplace = new RegExp(`(\\b|[-_\\[\\(\\s])0*${originalNumStr}(\\b|[-_\\]\\)\\.\\s]|$)`);
            return title.replace(fallbackReplace, `$1${newNumStr}$2`);
        }
    }
    return title;
}

/**
 * Mengekstrak slug Otakudesu dari string URL atau identifier.
 */
export function extractOtakuSlug(val) {
    if (!val) return null;
    let s = String(val).trim();
    if (s.includes('/anime/')) {
        s = s.split('/anime/').pop();
    } else if (s.includes(':')) {
        s = s.split(':').pop();
    }
    return s.replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Membersihkan judul anime dari teks SEO (Sub Indo, Subtitle Indonesia, dll)
 * serta metadata episode/batch (Episode X, Batch, End, Tamat)
 * dan menstandarkannya agar rapi untuk disimpan di database/UI.
 */
export function cleanSeriesTitle(title) {
    if (!title) return '';
    let t = String(title).trim();
    // 1. Hapus nama situs & kata kunci SEO (Sub Indo, Subtitle Indonesia, dll.)
    t = t.replace(/[-–|]\s*(?:Samehadaku|Otakudesu|Kuronime|Neosatsu).*$/i, '');
    t = t.replace(/\s*(?:\(?Sub(?:title)?\s*Indo(?:nesia)?\)?)\s*/gi, '');
    // 2. Hapus metadata episode & batch (Episode XX - XX, Tamat, End, OVA, Batch)
    t = t.replace(/(?:Episode|Eps)\s*\d+\s*-\s*\d+.*$/i, '');
    t = t.replace(/(?:Episode|Eps)\s*\d+.*$/i, '');
    t = t.replace(/\s*\d+\s*-\s*\d+\s*(?:Tamat|End)?.*$/i, '');
    t = t.replace(/\s*OVA\s*\d*.*$/i, '');
    t = t.replace(/(?:\s*[\(\[]?BD[\)\]]?\s*)?(?:\s*[\(\[]?Batch[\)\]]?\s*)/gi, '');
    t = t.replace(/\s*[\(\[]?(?:End|Tamat)[\)\]]?\s*/gi, '');
    // 3. Hapus pemisah dan karakter sisa di akhir string
    t = t.replace(/\s*[-–|]\s*$/i, '');
    return t.replace(/[-\s]+$/, '').replace(/\s+/g, ' ').trim();
}