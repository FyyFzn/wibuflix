import axios from 'axios';
import * as cheerio from 'cheerio';
import { fetchWithCF } from '../utils/scrapeHelper.js';
import { releaseToPool } from '../puppeteer/pool.js';
import { fetchNanimeInertia } from '../controllers/nanimeController.js';

/**
 * Diagnostic Script: check_provider_accessibility.js
 * 
 * Mengecek apakah semua web penyedia anime & tokusatsu (Samehadaku, Otakudesu, Kuronime,
 * Nanime ID, Nimegami, Oploverz, Neosatsu) dapat diakses dan mengembalikan URL yang benar
 * (serta mendeteksi jika terjadi redirect ke domain/mirror baru).
 */

const PROVIDERS = [
    {
        name: 'Samehadaku',
        baseUrl: 'https://v2.samehadaku.how/',
        catalogUrl: 'https://v2.samehadaku.how/daftar-anime-2/',
        type: 'html-cf',
        expectedKeyword: 'samehadaku'
    },
    {
        name: 'Otakudesu',
        baseUrl: 'https://otakudesu.blog/',
        catalogUrl: 'https://otakudesu.blog/anime-list/',
        type: 'html-cf',
        expectedKeyword: 'otakudesu'
    },
    {
        name: 'Kuronime',
        baseUrl: 'https://kuronime.sbs/',
        catalogUrl: 'https://kuronime.sbs/anime/?list',
        type: 'html-cf',
        expectedKeyword: 'kuronime'
    },
    {
        name: 'Nanime ID',
        baseUrl: 'https://nanimeid.net/',
        catalogUrl: 'https://nanimeid.net/explore?page=1',
        type: 'inertia-json',
        expectedKeyword: 'nanime'
    },
    {
        name: 'Nimegami',
        baseUrl: 'https://nimegami.id/',
        catalogUrl: 'https://nimegami.id/anime-list/',
        type: 'html-cf',
        expectedKeyword: 'nimegami'
    },
    {
        name: 'Oploverz',
        baseUrl: 'https://plus.oploverz.ltd/',
        catalogUrl: 'https://plus.oploverz.ltd/series',
        type: 'html-cf',
        expectedKeyword: 'oploverz'
    },
    {
        name: 'Neosatsu (Tokusatsu)',
        baseUrl: 'https://www.neosatsu.com/',
        catalogUrl: 'https://www.neosatsu.com/p/kamen-rider-series.html',
        type: 'axios-direct',
        expectedKeyword: 'neosatsu'
    }
];

export async function checkAllProvidersAccessibility() {
    console.log('\n================================================================================');
    console.log('                 WIBUFLIX PROVIDER ACCESSIBILITY & URL CHECKER                  ');
    console.log('================================================================================');
    console.log('Memeriksa konektivitas dan URL balik dari setiap web provider...');
    
    const results = [];

    for (const provider of PROVIDERS) {
        console.log(`\n -> Mengecek [${provider.name}] (${provider.baseUrl})...`);
        const result = {
            name: provider.name,
            targetUrl: provider.baseUrl,
            accessible: false,
            statusCode: null,
            returnedUrl: null,
            isRedirected: false,
            statusText: 'UNKNOWN',
            details: ''
        };

        try {
            if (provider.type === 'axios-direct') {
                const response = await axios.get(provider.baseUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    },
                    timeout: 20000,
                    maxRedirects: 5
                });

                result.statusCode = response.status;
                result.accessible = response.status === 200;
                result.returnedUrl = response.request?.res?.responseUrl || provider.baseUrl;
                
                if (result.returnedUrl && result.returnedUrl !== provider.baseUrl) {
                    result.isRedirected = true;
                }

                const bodyText = typeof response.data === 'string' ? response.data.toLowerCase() : JSON.stringify(response.data).toLowerCase();
                if (bodyText.includes(provider.expectedKeyword)) {
                    result.statusText = result.isRedirected ? 'ACCESSIBLE (REDIRECTED)' : 'ACCESSIBLE & CORRECT URL';
                    result.details = `URL aktif: ${result.returnedUrl}`;
                } else {
                    result.statusText = 'ACCESSIBLE (CONTENT WARNING)';
                    result.details = `Status 200 OK namun keyword "${provider.expectedKeyword}" tidak terdeteksi.`;
                }

            } else if (provider.type === 'inertia-json') {
                try {
                    const inertiaData = await fetchNanimeInertia(provider.baseUrl);
                    result.accessible = !!inertiaData && typeof inertiaData === 'object';
                    result.statusCode = result.accessible ? 200 : 502;
                    result.returnedUrl = inertiaData?.url ? `https://nanimeid.net${inertiaData.url}` : provider.baseUrl;
                    result.statusText = result.accessible ? 'ACCESSIBLE & CORRECT URL' : 'INACCESSIBLE';
                    result.details = result.accessible ? 'Inertia JSON respons valid' : 'Gagal mengambil Inertia JSON payload';
                } catch (errInertia) {
                    result.accessible = false;
                    result.statusCode = 502;
                    result.statusText = 'INACCESSIBLE';
                    result.details = `Inertia Error: ${errInertia.message}`;
                }

            } else {
                // html-cf: Menggunakan fetchWithCF / Cloudflare bypass
                let fetchRes = null;
                try {
                    fetchRes = await fetchWithCF(provider.baseUrl, { timeout: 30000, fetchTimeout: 10000 });
                } catch (errCf) {
                    result.details = `CF Fetch Error: ${errCf.message}`;
                } finally {
                    if (fetchRes?.slot) releaseToPool(fetchRes.slot);
                }

                if (fetchRes && fetchRes.html && fetchRes.html !== '404_NOT_FOUND') {
                    result.accessible = true;
                    result.statusCode = 200;
                    result.returnedUrl = fetchRes.finalUrl || provider.baseUrl;
                    
                    if (result.returnedUrl && result.returnedUrl !== provider.baseUrl && !result.returnedUrl.includes('cloudflare')) {
                        result.isRedirected = true;
                    }

                    const htmlLower = fetchRes.html.toLowerCase();
                    if (htmlLower.includes(provider.expectedKeyword) || htmlLower.includes('anime') || htmlLower.includes('episode')) {
                        result.statusText = result.isRedirected ? 'ACCESSIBLE (REDIRECTED)' : 'ACCESSIBLE & CORRECT URL';
                        result.details = `URL aktif: ${result.returnedUrl}`;
                    } else if (htmlLower.includes('just a moment') || htmlLower.includes('cloudflare')) {
                        result.statusText = 'CLOUDFLARE CHALLENGE';
                        result.details = 'Situs aktif namun memerlukan resolusi tantangan Cloudflare (Bot Protection).';
                    } else {
                        result.statusText = 'ACCESSIBLE (CONTENT CHECK)';
                        result.details = `HTML terambil (panjang: ${fetchRes.html.length} karakter). URL: ${result.returnedUrl}`;
                    }
                } else if (fetchRes && fetchRes.html === '404_NOT_FOUND') {
                    result.accessible = false;
                    result.statusCode = 404;
                    result.statusText = 'HTTP 404 NOT FOUND';
                    result.details = 'Base URL atau domain tidak ditemukan / sudah mati.';
                } else {
                    result.accessible = false;
                    result.statusCode = null;
                    result.statusText = 'INACCESSIBLE / TIMEOUT';
                    if (!result.details) result.details = 'Gagal menembus proteksi atau koneksi timeout.';
                }
            }

        } catch (error) {
            result.accessible = false;
            result.statusCode = error.response?.status || 500;
            result.statusText = 'ERROR / INACCESSIBLE';
            result.details = error.message;
        }

        results.push(result);
        console.log(`    Status: [${result.statusText}] -> ${result.details}`);
    }

    console.log('\n================================================================================');
    console.log('                          RINGKASAN HASIL PENGECEKAN                            ');
    console.log('================================================================================');
    console.table(results.map(r => ({
        Provider: r.name,
        Target_URL: r.targetUrl,
        Status_HTTP: r.statusCode || 'N/A',
        URL_Balik: r.returnedUrl || 'N/A',
        Status_Koneksi: r.statusText
    })));
    console.log('================================================================================\n');

    return results;
}

// Jalankan langsung jika dipanggil dari CLI node src/scripts/check_provider_accessibility.js
import { fileURLToPath } from 'url';
import fs from 'fs';
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
    checkAllProvidersAccessibility().then(() => {
        process.exit(0);
    }).catch((err) => {
        console.error('Error saat menjalankan pemeriksaan:', err);
        process.exit(1);
    });
}
