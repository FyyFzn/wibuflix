import axios from 'axios';
import * as cheerio from 'cheerio';
import { decryptNeosatsuLink, normalizeGDriveUrl } from '../../../utils/neosatsuUtils.js';
import { cache, IGNORED_CATS, cleanTitle } from './neosatsuShared.js';

/**
 * [TAHAP 2 & 3] Mengambil daftar episode DAN server.
 * Mendukung ekstraksi dari Label Feed (menggabungkan semua episode & movie) ATAU URL satuan.
 */
export async function getNeosatsuEpisodes(targetUrl) {
    if (!targetUrl) throw new Error("Parameter 'url' wajib diisi!");
    console.info(`\n[Neosatsu Scraper] Mengambil post/label dari: ${targetUrl}`);

    try {
        let feedUrl = '';
        let judulSeri = 'Tokusatsu Series';
        let cover = '';
        let allEntries = [];

        // Jika endpoint berasal dari label (Auto-Merge Backend)
        if (targetUrl.startsWith('neosatsu-merge:')) {
            const dataStr = targetUrl.split('neosatsu-merge:')[1];
            let targetTitle = '';
            let label = '';

            if (dataStr.includes('||')) {
                const parts = dataStr.split('||');
                targetTitle = parts[0];
                label = parts[1];
            } else {
                targetTitle = dataStr;
            }

            judulSeri = cleanTitle(targetTitle);

            if (label) {
                feedUrl = `https://www.neosatsu.com/feeds/posts/default/-/${encodeURIComponent(label)}?alt=json&max-results=500`;
            } else {
                feedUrl = `https://www.neosatsu.com/feeds/posts/default?q=${encodeURIComponent(targetTitle)}&alt=json&max-results=500`;
            }

            console.info(`[Neosatsu Scraper] Fetching Label/Search Feed: ${feedUrl}`);

            const { data: feedData } = await axios.get(feedUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 60000 });
            if (feedData && feedData.feed && feedData.feed.entry) {
                // FILTER HANYA YANG COCOK DENGAN TARGET TITLE! (Memisahkan Series dan Movie)
                allEntries = feedData.feed.entry.filter(entry => {
                    const entryTitle = entry.title.$t.replace(/Subtitle Indonesia.*$/i, '').replace(/Episode.*$/i, '').trim();
                    return entryTitle.toLowerCase() === targetTitle.toLowerCase();
                });

                // Ambil cover dari entri pertama
                if (allEntries[0] && allEntries[0].media$thumbnail) {
                    cover = allEntries[0].media$thumbnail.url.replace(/\/s\d+-c\//, '/s1600/');
                }
            }
        }
        // Fallback untuk URL lama yang sudah tersimpan di database/bookmark
        else {
            const { data: html } = await axios.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 60000 });
            const $ = cheerio.load(html);
            judulSeri = $('h1.entry-title').text().trim().replace(/Subtitle Indonesia.*$/i, '').trim() || 'Tokusatsu Series';
            cover = $('.thumbnail img').first().attr('src') || $('meta[property="og:image"]').attr('content') || '';
            if (cover) cover = cover.replace(/\/w\d+-h\d+(-[c|p|s])?(-[a-zA-Z0-9]+)?\//g, '/s1600/');

            // Coba cari label dari HTML untuk fallback merging
            let seriesLabel = '';
            $('a[rel="tag"]').each((i, el) => {
                const tag = $(el).text().trim();
                if (tag && !IGNORED_CATS.includes(tag.toLowerCase())) {
                    seriesLabel = tag;
                }
            });

            if (seriesLabel) {
                feedUrl = `https://www.neosatsu.com/feeds/posts/default/-/${encodeURIComponent(seriesLabel)}?alt=json&max-results=500`;
                console.info(`[Neosatsu Scraper] Fallback Merging via Label: ${feedUrl}`);
                const { data } = await axios.get(feedUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 60000 });
                if (data && data.feed && data.feed.entry) {
                    allEntries = data.feed.entry;
                }
            } else {
                // Jika tidak ada label, buat dummy entry dari HTML ini saja
                allEntries = [{
                    title: { $t: judulSeri },
                    content: { $t: html }
                }];
            }
        }

        const daftar_episode = [];

        // Loop setiap post yang berhubungan dengan seri ini
        for (const entry of allEntries) {
            const postTitle = entry.title.$t;
            const content = entry.content ? entry.content.$t : '';
            if (!content) continue;

            let isMovieOrSpecial = false;
            if (postTitle.toLowerCase().includes('movie') || postTitle.toLowerCase().includes('spin-off') || postTitle.toLowerCase().includes('hyper battle') || postTitle.toLowerCase().includes('vs')) {
                isMovieOrSpecial = true;
            }

            const match = content.match(/(?:var\s+dlItem|dlItem|const\s+dlItem|let\s+dlItem)\s*=\s*(\[[\s\S]*?\])\s*(?:;|\/\/|<\/script>)/i);
            if (match && match[1]) {
                let parsedData = [];
                try {
                    parsedData = JSON.parse(match[1].replace(/(['"])?([a-zA-Z0-9_]+)(['"])?:/g, '"$2":').replace(/'/g, '"'));
                } catch (e1) {
                    try {
                        const parseFunc = new Function(`return ${match[1]};`);
                        parsedData = parseFunc();
                    } catch (e2) {
                        console.error("Gagal parse array JS Neosatsu:", e2.message);
                    }
                }

                parsedData.forEach(ep => {
                    let epTitle = ep.name.trim(); // "Kamen Rider Zeztz Episode 37" atau sekedar "Link Download"
                    if (epTitle.toLowerCase().includes('batch')) return;

                    // Jika epTitle hanya "Link Download", kita harus pakai postTitle untuk menamainya
                    const lowerName = epTitle.toLowerCase();
                    if (lowerName.includes('link download') || lowerName.includes('download episode') || lowerName.includes('download batch') || lowerName === 'download') {
                        let extractedName = postTitle.replace(/Subtitle Indonesia.*$/i, '').trim();
                        const epMatch = extractedName.match(/Episode\s*\d+.*?$/i);
                        if (epMatch) {
                            epTitle = epMatch[0]; // misal "Episode 45"
                        } else {
                            // Coba hapus nama franchise agar lebih pendek
                            const franchiseStrip = extractedName.replace(new RegExp(`.*?${judulSeri}`, 'i'), '').replace(/^[:\-\s]+/, '');
                            epTitle = franchiseStrip || extractedName;
                        }
                    }

                    if (isMovieOrSpecial && !epTitle.toLowerCase().includes('movie') && !epTitle.toLowerCase().includes('special') && !epTitle.toLowerCase().includes('spin-off')) {
                        epTitle = `[Spesial/Movie] ${epTitle}`;
                    }

                    // CLEAN EPISODE TITLE
                    let cleanTitle = epTitle;
                    
                    const isBatchMatch = cleanTitle.match(/Episode\s*\d+\s*(?:[\-\~]|s\/d|sampai|to)\s*\d+/i);
                    if (isBatchMatch) {
                        cleanTitle = judulSeri || 'Full Series';
                    } else {
                        if (judulSeri && judulSeri.length > 2) {
                            const regexFranchise = new RegExp(judulSeri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                            cleanTitle = cleanTitle.replace(regexFranchise, '').trim();
                        }

                        cleanTitle = cleanTitle.replace(/\s*(-|~)?\s*(Tamat|End|Subtitle Indonesia|Sub Indo|Subtitle|Indonesia)\s*/gi, '').trim();

                        if (!isMovieOrSpecial) {
                            const epMatch = cleanTitle.match(/Episode\s*\d+/i);
                            if (epMatch) {
                                cleanTitle = epMatch[0]; 
                            } else {
                                const numMatch = cleanTitle.match(/^\s*\d+\s*$/);
                                if (numMatch) {
                                    cleanTitle = `Episode ${numMatch[0].trim()}`;
                                }
                            }
                        }

                        cleanTitle = cleanTitle.replace(/^[\-\:\s]+|[\-\:\s]+$/g, '');
                        if (!cleanTitle) cleanTitle = judulSeri || 'Full Series';
                    }

                    epTitle = cleanTitle;

                    // Logika Ekstrak Server
                    let hasNestedEpisodes = false;
                    if (ep.item && Array.isArray(ep.item)) {
                        ep.item.forEach(resGroup => {
                            const resolusi = resGroup.label;
                            if (resolusi.toLowerCase().includes('batch')) return;

                            if (resolusi.toLowerCase().includes('episode') || (!resolusi.toLowerCase().includes('p') && resolusi.match(/^[0-9\-\s]+$/))) {
                                hasNestedEpisodes = true;
                                const nestedServers = [];
                                if (resGroup.link && Array.isArray(resGroup.link)) {
                                    resGroup.link.forEach(serverObj => {
                                        const serverName = serverObj.name || '';
                                        const fullUrl = decryptNeosatsuLink(serverObj.ids);
                                        if (fullUrl) {
                                            const finalIframeUrl = normalizeGDriveUrl(fullUrl);
                                            nestedServers.push({
                                                nama: `HD ${serverName}`,
                                                namaHost: serverName.toLowerCase().includes('drive') ? 'gdrive' : serverName.toLowerCase(),
                                                urlAsli: fullUrl,
                                                iframeUrl: finalIframeUrl
                                            });
                                        }
                                    });
                                }

                                if (nestedServers.length > 0) {
                                    let nestedEpTitle = resolusi.trim();
                                    // Movie name separation
                                    if (judulSeri.toLowerCase().includes('movie') || judulSeri.toLowerCase().includes('spesial')) {
                                        // It's a separated movie card, no need to add [Movie] tag
                                    } else if (isMovieOrSpecial) {
                                        nestedEpTitle = `[Spesial/Movie] ${nestedEpTitle}`;
                                    }
                                    const fakeEpUrl = `${targetUrl}___neosatsu_ep___${nestedEpTitle.replace(/\s+/g, '_')}`;
                                    daftar_episode.push({
                                        judul: nestedEpTitle,
                                        url: fakeEpUrl,
                                        _servers: nestedServers
                                    });
                                }
                            }
                        });
                    }

                    if (!hasNestedEpisodes) {
                        const resolutions = [];
                        if (ep.item && Array.isArray(ep.item)) {
                            ep.item.forEach(resGroup => {
                                const resolusi = resGroup.label;
                                if (resolusi.toLowerCase().includes('batch')) return;

                                if (resGroup.link && Array.isArray(resGroup.link)) {
                                    resGroup.link.forEach(serverObj => {
                                        const serverName = serverObj.name || '';
                                        const fullUrl = decryptNeosatsuLink(serverObj.ids);
                                        if (fullUrl) {
                                            const finalIframeUrl = normalizeGDriveUrl(fullUrl);
                                            resolutions.push({
                                                nama: `${resolusi} ${serverName}`.trim(),
                                                namaHost: serverName.toLowerCase().includes('drive') ? 'gdrive' : serverName.toLowerCase(),
                                                urlAsli: fullUrl,
                                                iframeUrl: finalIframeUrl
                                            });
                                        }
                                    });
                                }
                            });
                        }

                        if (resolutions.length > 0) {
                            const fakeEpUrl = `${targetUrl}___neosatsu_ep___${epTitle.replace(/\s+/g, '_')}`;
                            daftar_episode.push({
                                    judul: epTitle,
                                    url: fakeEpUrl,
                                    _servers: resolutions
                            });
                        }
                    }
                });
            }
        }

        // Sorting Pintar
        if (daftar_episode.length > 1) {
            const getEpNum = (title) => {
                const match = title.match(/Episode\s*(\d+(?:\.\d+)?)/i) || title.match(/Ep\s*(\d+(?:\.\d+)?)/i);
                return match ? parseFloat(match[1]) : -1;
            };

            // Deduplikasi
            const seenEpNums = new Set();
            const seenTitles = new Set();
            const uniqueEpisodes = [];

            for (let i = 0; i < daftar_episode.length; i++) {
                const ep = daftar_episode[i];
                const num = getEpNum(ep.judul);
                if (num !== -1) {
                    if (!seenEpNums.has(num)) {
                        seenEpNums.add(num);
                        uniqueEpisodes.push(ep);
                    }
                } else {
                    const lowerTitle = ep.judul.toLowerCase();
                    if (!seenTitles.has(lowerTitle)) {
                        seenTitles.add(lowerTitle);
                        uniqueEpisodes.push(ep);
                    }
                }
            }

            // Timpa array asli dengan array yang sudah unik
            daftar_episode.splice(0, daftar_episode.length, ...uniqueEpisodes);

            // Mengurutkan secara numerik agar Episode 1 selalu di atas
            daftar_episode.sort((a, b) => {
                const numA = getEpNum(a.judul);
                const numB = getEpNum(b.judul);
                
                if (numA !== -1 && numB !== -1) return numA - numB;
                if (numA !== -1 && numB === -1) return -1;
                if (numB !== -1 && numA === -1) return 1;
                return 0;
            });
        }

        // Simpan cache (MAL akan diurus oleh rute episodes.js menggunakan DB lokal)
        const finalResult = {
            judul_seri: judulSeri,
            cover_scraper: cover,
            daftar_episode: daftar_episode
        };
        if (daftar_episode.length > 0) {
            cache.set(targetUrl, finalResult);
        } else {
            console.warn(`[Neosatsu] Peringatan: 0 episode ditemukan untuk ${targetUrl}. Hasil tidak disimpan ke cache.`);
        }

        return finalResult;
    } catch (err) {
        console.error('[Neosatsu Episodes Error]:', err.message);
        throw err;
    }
}
