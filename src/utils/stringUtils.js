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
    
    // Hapus embel-embel umum
    t = t.replace(/subtitle indonesia|sub indo|batch|ongoing|on-going|tv series|movie/gi, '');
    
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
    
    let season = null;
    let part = null;
    
    const seasonMatch = title.match(/(?:season|s)\s*(\d+)/i);
    if (seasonMatch) season = parseInt(seasonMatch[1]);
    
    const partMatch = title.match(/(?:part|p)\s*(\d+)/i);
    if (partMatch) part = parseInt(partMatch[1]);
    
    return { season, part };
}

/**
 * Validasi ekstra apakah dua anime aman untuk digabungkan.
 * Jika threshold > 60%, ini akan memastikan Season dan Part-nya tidak bertabrakan.
 * (Cth: Mencegah 'S2' bergabung dengan 'S3' meskipun stringnya 93% mirip).
 */
export function isSafeToMerge(title1, title2, scoreThreshold = 0.6) {
    const norm1 = normalizeTitleForMatch(title1);
    const norm2 = normalizeTitleForMatch(title2);
    
    const score = diceCoefficient(norm1, norm2);
    if (score < scoreThreshold) return { isSafe: false, score };
    
    // Validasi ketat angka Season dan Part
    const meta1 = extractSeasonAndPart(title1);
    const meta2 = extractSeasonAndPart(title2);
    
    if (meta1.season !== null && meta2.season !== null && meta1.season !== meta2.season) {
        return { isSafe: false, score }; // Berbeda Season
    }
    
    if (meta1.part !== null && meta2.part !== null && meta1.part !== meta2.part) {
        return { isSafe: false, score }; // Berbeda Part
    }
    
    // Jika satu punya Season tapi yang lain tidak, kita asumsikan yang tidak punya adalah Season 1
    // Cth: "Kimetsu no Yaiba" (S1) vs "Kimetsu no Yaiba S2"
    if (meta1.season === null && meta2.season !== null && meta2.season !== 1) return { isSafe: false, score };
    if (meta2.season === null && meta1.season !== null && meta1.season !== 1) return { isSafe: false, score };
    
    return { isSafe: true, score };
}
