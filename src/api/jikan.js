const axios = require('axios');
const NodeCache = require('node-cache');

// Cache MAL data 24 jam di memory
const malCache     = new NodeCache({ stdTTL: 86400 });
const episodeCache = new NodeCache({ stdTTL: 86400 });

// ── In-flight deduplication ───────────────────────────────────
// Mencegah request duplikat yang sama dieksekusi bersamaan
const inFlight = new Map();

// ── Concurrent Rate Limiter dengan Global 429 Pause ─────────
// Jikan v4: 3 req/detik. Kita pakai 2 concurrent + 350ms delay
// = ~2.8 req/detik. Jika dapat 429, seluruh queue dipause.
const MAX_CONCURRENT = 2;
const DELAY_MS       = 670;

const requestQueue = [];
let activeCount  = 0;
let pauseUntil   = 0; 

function processQueue() {
    const now = Date.now();
    if (now < pauseUntil) {
        setTimeout(processQueue, pauseUntil - now);
        return;
    }
    while (activeCount < MAX_CONCURRENT && requestQueue.length > 0) {
        const job = requestQueue.shift();
        activeCount++;

        job.run()
            .then(job.resolve)
            .catch(job.reject)
            .finally(() => {
                setTimeout(() => {
                    activeCount--;
                    processQueue();
                }, DELAY_MS);
            });
    }
}

function pauseQueue(ms) {
    pauseUntil = Math.max(pauseUntil, Date.now() + ms);
    console.warn(`[Jikan] Queue dipause ${ms}ms karena rate limit`);
}

function enqueue(runFn) {
    return new Promise((resolve, reject) => {
        requestQueue.push({ run: runFn, resolve, reject });
        processQueue();
    });
}

// Retry otomatis untuk 429 dan 5xx
async function httpGetWithRetry(url, maxRetry = 3) {
    for (let attempt = 0; attempt <= maxRetry; attempt++) {
        try {
            const response = await axios.get(url, { timeout: 8000 });
            return response.data;
        } catch (err) {
            if (err.response) {
                const status = err.response.status;
                if (status === 429) {
                    const wait = 3000 + attempt * 2000;
                    pauseQueue(wait);
                    await new Promise(r => setTimeout(r, wait));
                    continue;
                }
                if (status >= 500) {
                    const wait = (attempt + 1) * 600;
                    console.warn(`[Jikan] HTTP ${status}, retry ${attempt + 1}/${maxRetry} in ${wait}ms...`);
                    await new Promise(r => setTimeout(r, wait));
                    continue;
                }
            }
            if (attempt === maxRetry) throw err;
            await new Promise(r => setTimeout(r, (attempt + 1) * 400));
        }
    }
    return null;
}

// ── Normalisasi judulse ───────────────
function normalizeTitle(title) {
    return title
        .toLowerCase()
        // Hapus kata-kata "sampah" dari scraper
        .replace(/\(tv\)/gi, '')
        .replace(/\(sub indo\)/gi, '')
        .replace(/subtitle indonesia/gi, '')
        .replace(/\[batch\]/gi, '')
        .replace(/\(batch\)/gi, '')
        // Hapus karakter khusus agar tidak menyebabkan URL error, diganti ke spasi
        .replace(/[^\w\s]/g, ' ')
        // Hapus spasi berlebih
        .replace(/\s+/g, ' ')
        .trim();
}

// ── findBestMatch ───────────────
function findBestMatch(results, query) {
    if (!results || results.length === 0) return null;
    const qLower = query.toLowerCase();
    
    for (const anime of results) {
        const tMain = (anime.title || '').toLowerCase();
        const tEng = (anime.title_english || '').toLowerCase();
        const syns = (anime.title_synonyms || []).map(s => s.toLowerCase());
        const allTitles = [tMain, tEng, ...syns];
        if (allTitles.includes(qLower)) return anime;
    }

    const seasonMatch = qLower.match(/season\s*(\d+)/) || qLower.match(/s(\d+)/) || qLower.match(/(\d+)nd season/) || qLower.match(/(\d+)rd season/);
    const targetSeason = seasonMatch ? seasonMatch[1] : null;
    const isPart2 = qLower.includes('part 2') || qLower.includes('cour 2');

    if (!targetSeason && !isPart2) {
        return results[0];
    }

    for (const anime of results) {
        const tMain = (anime.title || '').toLowerCase();
        const tEng = (anime.title_english || '').toLowerCase();
        const syns = (anime.title_synonyms || []).map(s => s.toLowerCase());
        const allTitles = [tMain, tEng, ...syns];
        const fullText = allTitles.join(' ');

        let matchesSeason = true;
        if (targetSeason) {
            matchesSeason = allTitles.some(t => 
                t.match(new RegExp(`season\\s*${targetSeason}`)) || 
                t.match(new RegExp(`${targetSeason}nd season`)) ||
                t.match(new RegExp(`${targetSeason}rd season`)) ||
                t.match(new RegExp(`${targetSeason}th season`)) ||
                (targetSeason === '2' && (t.includes(' ii') || t.match(/\bii\b/))) ||
                (targetSeason === '3' && (t.includes(' iii') || t.match(/\biii\b/))) ||
                (targetSeason === '4' && (t.includes(' iv') || t.match(/\biv\b/))) ||
                t.match(new RegExp(`\\s${targetSeason}$`))
            );
        }

        let matchesPart = true;
        if (isPart2) {
            matchesPart = fullText.includes('part 2') || fullText.includes('cour 2');
        } else {
            matchesPart = !(fullText.includes('part 2') || fullText.includes('cour 2'));
        }

        if (matchesSeason && matchesPart) {
            return anime;
        }
    }

    return results[0];
}

// ── searchAnime ──────────────────────────────────────────────
async function searchAnime(title) {
    if (!title) return null;

    const normalized = normalizeTitle(title);
    const cacheKey   = `mal|${normalized}`;

    const cached = malCache.get(cacheKey);
    if (cached !== undefined) return cached;

    if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

    const promise = enqueue(async () => {
        const json = await httpGetWithRetry(
            `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(normalized)}&limit=5&sfw=true`
        );
        if (!json || !json.data || json.data.length === 0) return null;
        
        const a = findBestMatch(json.data, normalized);
        return {
            malId:    a.mal_id,
            malUrl:   a.url,
            malScore: a.score ? a.score.toFixed(1) : null,
            malRank:  a.rank,
            genres:   (a.genres  || []).map(g => g.name).slice(0, 4),
            synopsis: a.synopsis || '',
            episodes: a.episodes,
            status:   a.status,
            cover:    a.images?.jpg?.large_image_url || a.images?.jpg?.image_url || null,
            coverWebp: a.images?.webp?.large_image_url || null,
            studios:  (a.studios || []).map(s => s.name),
            year:     a.year || (a.aired?.from ? new Date(a.aired.from).getFullYear() : null),
            rating:   a.rating,
        };
    })
    .then(result => {
        malCache.set(cacheKey, result);
        return result;
    })
    .catch(err => {
        console.warn(`[Jikan] searchAnime error "${normalized}":`, err.message);
        malCache.set(cacheKey, null, 3600);
        return null;
    })
    .finally(() => {
        inFlight.delete(cacheKey);
    });

    inFlight.set(cacheKey, promise);
    return promise;
}

// ── getAnimeEpisodes ─────────────────────────────────────────
async function getAnimeEpisodes(malId, totalEps) {
    if (!malId) return {};

    const cacheKey = `mal_eps|${malId}`;
    const cached   = episodeCache.get(cacheKey);
    if (cached !== undefined) return cached;

    if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

    const promise = (async () => {
        try {
            const maxPages = Math.min(Math.ceil((totalEps || 100) / 100), 5);
            const firstJson = await enqueue(() =>
                httpGetWithRetry(`https://api.jikan.moe/v4/anime/${malId}/episodes?page=1`)
            );

            if (!firstJson || !firstJson.data || firstJson.data.length === 0) {
                episodeCache.set(cacheKey, {});
                return {};
            }

            const episodeMap = {};
            firstJson.data.forEach(ep => {
                const title = ep.title || ep.title_romanji || '';
                if (title) episodeMap[String(ep.mal_id)] = title;
            });

            const realMaxPages = firstJson.pagination?.last_visible_page ?? maxPages;
            const pagesToFetch = Math.min(realMaxPages, maxPages);

            if (pagesToFetch > 1 && firstJson.data.length === 100) {
                const pageNums   = Array.from({ length: pagesToFetch - 1 }, (_, i) => i + 2);
                const pageResults = await Promise.allSettled(
                    pageNums.map(p =>
                        enqueue(() =>
                            httpGetWithRetry(`https://api.jikan.moe/v4/anime/${malId}/episodes?page=${p}`)
                        )
                    )
                );

                pageResults.forEach(res => {
                    if (res.status === 'fulfilled' && res.value && res.value.data) {
                        res.value.data.forEach(ep => {
                            const title = ep.title || ep.title_romanji || '';
                            if (title) episodeMap[String(ep.mal_id)] = title;
                        });
                    }
                });
            }

            console.log(`[Jikan] Episodes fetched for malId=${malId}: ${Object.keys(episodeMap).length} judul`);
            episodeCache.set(cacheKey, episodeMap);
            return episodeMap;
        } catch (err) {
            console.warn(`[Jikan] getAnimeEpisodes error malId=${malId}:`, err.message);
            episodeCache.set(cacheKey, {}, 3600);
            return {};
        }
    })();

    promise.finally(() => inFlight.delete(cacheKey));
    inFlight.set(cacheKey, promise);
    return promise;
}

module.exports = { searchAnime, getAnimeEpisodes };
