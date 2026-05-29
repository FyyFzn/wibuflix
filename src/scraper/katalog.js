const { fetchPage, kembalikanKePool } = require('../puppeteer/pool');

const NodeCache = require('node-cache');
const cache = new NodeCache({ stdTTL: 3600 }); // Cache 1 jam (super cepat)

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

            // Better pagination detection:
            // If we got items, assume there's a next page unless we're sure there isn't
            if (list.length > 0 && !hasNext) {
                // Only set hasNext to false if pagination explicitly says so
                // Otherwise assume there might be more content
                hasNext = true; // Default to true unless pagination proves otherwise
            }
            
            return { list, hasNext, html: list.length === 0 ? document.body.innerHTML.substring(0, 1000) : null };
        }, url);

        result.list = result.list.slice(0, 9); // Batasi maksimal 9 anime per page

        if (result.list.length === 0) {
            console.log('[DEBUG] list is empty! HTML preview:', result.html);
            result.hasNext = false; // If no items, definitely no next
        } else {
            // MAL enrichment ditiadakan di katalog untuk menghindari rate-limit Jikan API
            // dan mempercepat pemuatan awal (hanya memakan waktu 3-5 detik via Puppeteer).
            // Gambar dan Skor akan murni menggunakan data yang didapat dari scraper.
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
