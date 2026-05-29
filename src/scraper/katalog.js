const { fetchPage, kembalikanKePool } = require('../puppeteer/pool');
const { searchAnime } = require('../api/jikan');
const NodeCache = require('node-cache');
const cache = new NodeCache({ stdTTL: 600 }); // Cache 10 menit

async function getKatalog(pageParams, searchParam) {
    const isSearch = searchParam.trim() !== '';
    const cacheKey = `katalog_${pageParams}_${searchParam}`;
    
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
        console.log(`[Katalog Cache Hit] ${cacheKey}`);
        return cachedData;
    }

    let url = 'https://v2.samehadaku.how/';
    if (isSearch) {
        url += `page/${pageParams}/?s=${encodeURIComponent(searchParam)}`;
    } else {
        url += `daftar-anime-2/`;
        if (pageParams > 1) url += `page/${pageParams}/`;
    }

    console.log(`\n[Katalog Fetch] ${url}`);

    let slot;
    try {
        slot = await fetchPage(url);
        const page = slot.page;

        const result = await page.evaluate((currentUrl) => {
            const list = [];
            const isSearch = currentUrl.includes('?s=');
            const isDaftarAnime = currentUrl.includes('daftar-anime');
            let hasNext = false;
            let itemSelector = '.post-show ul li';

            if (isSearch || isDaftarAnime) {
                hasNext = !!document.querySelector('.pagination .next');
                itemSelector = '.animepost';
            } else {
                document.querySelectorAll('.pagination a').forEach(a => {
                    if (a.innerText.includes('Next') || a.classList.contains('next')) hasNext = true;
                });
            }

            document.querySelectorAll(itemSelector).forEach(el => {
                const titleNode  = el.querySelector('.title, .tt h2, .entry-title');
                const linkNode   = el.querySelector('a');
                const imgNode    = el.querySelector('img');
                const typeNode   = el.querySelector('.typez, .type, .bt span.type');
                const scoreNode  = el.querySelector('.score, .numscore, .rating');
                const statusNode = el.querySelector('.status, .epx, .sb, .bt span:not(.type)');

                if (titleNode && linkNode && imgNode) {
                    const skorRaw   = scoreNode ? scoreNode.innerText.trim() : '';
                    const skorAngka = skorRaw.replace(/[^\d.]/g, '');

                    let epText = '';
                    if (!isSearch) {
                        const epNode = el.querySelector('author[itemprop="name"]');
                        if (epNode) epText = 'Eps ' + epNode.innerText.trim();
                    }

                    const gambarScraper =
                        imgNode.getAttribute('data-src') ||
                        imgNode.getAttribute('data-lazy-src') ||
                        imgNode.getAttribute('data-original') ||
                        imgNode.getAttribute('srcset')?.split(' ')[0] ||
                        imgNode.getAttribute('src') ||
                        '';

                    list.push({
                        judul: titleNode.innerText.trim(),
                        url:   linkNode.href,
                        gambar: gambarScraper,     // diisi ulang oleh MAL di bawah
                        gambarScraper,             // simpan sebagai fallback
                        tipe:   typeNode ? typeNode.innerText.trim().toUpperCase() : 'TV',
                        skor:   skorAngka || '-',
                        status: epText || (statusNode ? statusNode.innerText.trim() : 'Ongoing'),
                    });
                }
            });

            if (!hasNext && list.length >= 10) hasNext = true;
            return { list, hasNext, html: list.length === 0 ? document.body.innerHTML.substring(0, 1000) : null };
        }, url);

        result.list = result.list.slice(0, 10); // Batasi maksimal 10 anime per page

        if (result.list.length === 0) {
            console.log('[DEBUG] list is empty! HTML preview:', result.html);
        } else {
            // ── Enrich dengan MAL cover (concurrent, timeout 30 detik) ──
            const MAL_ENRICH_TIMEOUT = 30000;
            console.log(`[MAL] Enriching ${result.list.length} items dari katalog...`);

            const enrichStart = Date.now();
            const enrichPromise = Promise.allSettled(
                result.list.map(async item => {
                    try {
                        const mal = await searchAnime(item.judul);
                        if (mal && mal.cover) {
                            item.gambar = mal.cover;
                            item.skor   = mal.malScore || item.skor;
                        }
                    } catch (e) {
                        // tetap pakai gambarScraper sebagai fallback
                    }
                })
            );

            let timerId;
            const timeoutPromise = new Promise(resolve =>
                timerId = setTimeout(() => {
                    console.warn(`[MAL] Enrich timeout (${MAL_ENRICH_TIMEOUT}ms), pakai gambar scraper untuk sisanya`);
                    resolve();
                }, MAL_ENRICH_TIMEOUT)
            );

            await Promise.race([enrichPromise, timeoutPromise]);
            clearTimeout(timerId);
            console.log(`[MAL] Enrich selesai dalam ${Date.now() - enrichStart}ms`);
        }

        if (result.list.length > 0) {
            cache.set(cacheKey, result);
        }
        return result;
    } catch (err) {
        throw err;
    } finally {
        if (slot) kembalikanKePool(slot);
    }
}

module.exports = { getKatalog, cache };
