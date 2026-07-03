import stringSimilarity from 'string-similarity';

/**
 * Standarisasi judul anime/tokusatsu untuk deduplikasi
 */
export function standardizeAnimeTitle(title) {
    if (!title) return '';
    let t = title.toLowerCase();

    // Hapus franchise besar Tokusatsu agar string similarity tidak bias
    t = t.replace(/(kamen rider|power rangers|ultraman|super sentai)\s*/gi, '');

    // Konversi ordinal musim & bagian
    t = t
        .replace(/(\d+)(?:st|nd|rd|th)\s+season/gi, 's$1')
        .replace(/season\s+(\d+)/gi, 's$1')
        .replace(/\bii\b/gi, 's2')
        .replace(/\biii\b/gi, 's3')
        .replace(/\biv\b/gi, 's4')
        .replace(/part\s+(\d+)/gi, 'p$1')
        .replace(/cour\s+(\d+)/gi, 'p$1');

    // Hapus kata sampah scraper
    t = t
        .replace(/\(tv\)/gi, '')
        .replace(/subtitle indonesia|sub indo|batch|ongoing|on-going|tv series/gi, '')
        .replace(/\[.*?\]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return t;
}

/**
 * Menghitung apakah dua judul cukup aman untuk digabungkan berdasarkan threshold standar
 */
export function isSafeToMerge(titleA, titleB, scoreThreshold = 0.85) {
    if (!titleA || !titleB) return false;

    // Jangan gabungkan Movie dengan non-Movie
    const isMovieA = titleA.toLowerCase().includes('movie') || titleA.toLowerCase().includes('gekijouban');
    const isMovieB = titleB.toLowerCase().includes('movie') || titleB.toLowerCase().includes('gekijouban');
    if (isMovieA !== isMovieB) return false;

    const sA = standardizeAnimeTitle(titleA);
    const sB = standardizeAnimeTitle(titleB);

    if (!sA || !sB) return false;

    const similarity = stringSimilarity.compareTwoStrings(sA, sB);
    return similarity >= scoreThreshold;
}
