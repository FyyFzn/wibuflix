import { getSamehadakuEpisodes } from '../controllers/samehadakuController.js';
import { scrapeVideoServers } from '../services/extractors/videoExtractor.js';
import * as otakudesu from '../controllers/otakudesuController.js';
import { getKuronimeEpisodes, getKuronimeServers } from '../controllers/kuronimeController.js';
import { getNanimeEpisodes, getNanimeServers } from '../controllers/nanimeController.js';
import { getNimegamiEpisodes, getNimegamiServers } from '../controllers/nimegamiController.js';
import { getOploverzEpisodes, getOploverzServers } from '../controllers/oploverzController.js';
import { getNeosatsuEpisodes, getNeosatsuServers, getNeosatsuCatalog } from '../services/scrapers/neosatsuScraperService.js';
import { fetchWithCF } from '../utils/scrapeHelper.js';
import { releaseToPool } from '../puppeteer/pool.js';
import * as cheerio from 'cheerio';
import mongoose from 'mongoose';
import Anime from '../models/Anime.js';
import { PROVIDER_URLS } from '../config/providerUrls.js';

// Mencegah Mongoose buffering timeout jika database tidak terhubung di CLI script ini
if (mongoose.connection.readyState === 0) {
    const origFindOne = Anime.findOne;
    Anime.findOne = function() {
        return {
            lean: async () => null,
            exec: async () => null,
            then: (res) => Promise.resolve(null)
        };
    };
}

/**
 * Diagnostic Deep Extraction Check
 * 
 * Mengecek apakah setiap web provider berhasil mengembalikan:
 * 1. Detail Anime & Daftar Episode (daftar_episode)
 * 2. Detail Episode & Link Stream/Download (servers)
 */

async function getSampleAnimeUrl(providerName) {
    if (providerName === 'Samehadaku') {
        let res;
        try {
            res = await fetchWithCF(PROVIDER_URLS.SAMEHADAKU.CATALOG_URL);
            if (res?.html && res.html !== '404_NOT_FOUND') {
                const $ = cheerio.load(res.html);
                const firstUrl = $('.animepost a').first().attr('href');
                if (firstUrl) return firstUrl;
            }
        } finally {
            if (res?.slot) releaseToPool(res.slot);
        }
        return `${PROVIDER_URLS.SAMEHADAKU.BASE_URL}/anime/naruto-shippuden/`;
    } else if (providerName === 'Otakudesu') {
        let res;
        try {
            res = await fetchWithCF(PROVIDER_URLS.OTAKUDESU.CATALOG_URL);
            if (res?.html && res.html !== '404_NOT_FOUND') {
                const $ = cheerio.load(res.html);
                const firstUrl = $('.jdlbar ul li a').first().attr('href') || $('#daftaranime ul li a').first().attr('href');
                if (firstUrl) return firstUrl;
            }
        } finally {
            if (res?.slot) releaseToPool(res.slot);
        }
        return `${PROVIDER_URLS.OTAKUDESU.BASE_URL}/anime/nru-shp-sub-indo/`;
    } else if (providerName === 'Kuronime') {
        let res;
        try {
            res = await fetchWithCF(PROVIDER_URLS.KURONIME.CATALOG_URL);
            if (res?.html && res.html !== '404_NOT_FOUND') {
                const $ = cheerio.load(res.html);
                const firstUrl = $('.soralist ul li a').first().attr('href');
                if (firstUrl) return firstUrl;
            }
        } finally {
            if (res?.slot) releaseToPool(res.slot);
        }
        return `${PROVIDER_URLS.KURONIME.BASE_URL}/anime/bleach-thousand-year-blood-war-sub-indo/`;
    } else if (providerName === 'Nanime ID') {
        return `${PROVIDER_URLS.NANIME.BASE_URL}/anime/one-piece`;
    } else if (providerName === 'Nimegami') {
        return `${PROVIDER_URLS.NIMEGAMI.BASE_URL}/dr-stone-new-world-sub-indo/`;
    } else if (providerName === 'Oploverz') {
        return `${PROVIDER_URLS.OPLOVERZ.BASE_URL}/series/one-piece`;
    } else if (providerName === 'Neosatsu') {
        try {
            const data = await getNeosatsuCatalog(1, '', '');
            if (data?.anime?.length > 0) return data.anime[0].endpoint;
        } catch (e) {}
        return `${PROVIDER_URLS.NEOSATSU.BASE_URL}/2024/09/kamen-rider-gavv-sub-indo.html`;
    }
    return null;
}

export async function runDeepExtractionCheck() {
    console.log('\n================================================================================');
    console.log('                 WIBUFLIX DEEP EXTRACTION & DOWNLOAD LINK CHECK                 ');
    console.log('================================================================================');
    console.log('Memeriksa pengambilan Detail Anime, Daftar Episode, & Link Stream/Download...\n');

    const providers = ['Samehadaku', 'Otakudesu', 'Kuronime', 'Nanime ID', 'Nimegami', 'Oploverz', 'Neosatsu'];
    const summary = [];

    for (const name of providers) {
        console.log(`--------------------------------------------------------------------------------`);
        console.log(`[>>] Menguji Provider: ${name}`);
        
        const report = {
            Provider: name,
            Detail_Anime_Judul: '-',
            Total_Episode: 0,
            Detail_Episode_Judul: '-',
            Total_Server_Link: 0,
            Status_Akhir: 'GAGAL'
        };

        try {
            const animeUrl = await getSampleAnimeUrl(name);
            console.log(`     -> Sample Anime URL: ${animeUrl}`);

            // 1. Uji Detail Anime & Daftar Episode
            let epCatalog = null;
            if (name === 'Samehadaku') epCatalog = await getSamehadakuEpisodes(animeUrl);
            else if (name === 'Otakudesu') {
                const slug = animeUrl.split('/').filter(Boolean).pop();
                epCatalog = await otakudesu.getOtakuEpisodesFormatted(slug);
            }
            else if (name === 'Kuronime') epCatalog = await getKuronimeEpisodes(animeUrl);
            else if (name === 'Nanime ID') epCatalog = await getNanimeEpisodes(animeUrl);
            else if (name === 'Nimegami') epCatalog = await getNimegamiEpisodes(animeUrl);
            else if (name === 'Oploverz') epCatalog = await getOploverzEpisodes(animeUrl);
            else if (name === 'Neosatsu') epCatalog = await getNeosatsuEpisodes(animeUrl);

            if (epCatalog && epCatalog.daftar_episode && epCatalog.daftar_episode.length > 0) {
                report.Detail_Anime_Judul = epCatalog.judul_seri || 'Terambil';
                report.Total_Episode = epCatalog.daftar_episode.length;
                console.log(`     ✅ Detail Anime sukses: "${report.Detail_Anime_Judul}" (${report.Total_Episode} episode terdeteksi)`);

                // 2. Uji Detail Episode & Link Download/Server Stream
                const sampleEp = epCatalog.daftar_episode.find(ep => !ep.judul.toLowerCase().includes('batch') && (!ep.url || !ep.url.includes('/batch/'))) || epCatalog.daftar_episode[0];
                const epUrl = sampleEp.url || sampleEp.slug;
                console.log(`     -> Menguji Ekstraksi Link Episode: "${sampleEp.judul}" (${epUrl})...`);

                let serverData = null;
                if (name === 'Samehadaku') serverData = await scrapeVideoServers(epUrl);
                else if (name === 'Otakudesu') serverData = await otakudesu.getServersInternal(epUrl);
                else if (name === 'Kuronime') serverData = await getKuronimeServers(epUrl);
                else if (name === 'Nanime ID') serverData = await getNanimeServers(epUrl);
                else if (name === 'Nimegami') serverData = await getNimegamiServers(epUrl);
                else if (name === 'Oploverz') serverData = await getOploverzServers(epUrl);
                else if (name === 'Neosatsu') serverData = await getNeosatsuServers(epUrl);

                if (serverData && serverData.servers && serverData.servers.length > 0) {
                    report.Detail_Episode_Judul = serverData.judul || sampleEp.judul;
                    report.Total_Server_Link = serverData.servers.length;
                    report.Status_Akhir = 'BERHASIL & LENGKAP';
                    console.log(`     ✅ Detail Episode & Link Stream/Download sukses! Ditemukan ${report.Total_Server_Link} server/mirror link.`);
                    console.log(`        Contoh Server: ${serverData.servers.slice(0, 3).map(s => `[${s.nama || s.provider || 'Direct'}]`).join(', ')}`);
                } else {
                    report.Detail_Episode_Judul = serverData?.judul || sampleEp.judul;
                    report.Status_Akhir = 'ONLY EPISODES (NO SERVERS)';
                    console.log(`     ⚠️ Daftar episode terambil namun getServers tidak mengembalikan link (atau diproteksi/kosong).`);
                }
            } else {
                console.log(`     ❌ Gagal mengambil daftar episode dari ${animeUrl}`);
            }
        } catch (e) {
            console.error(`     ❌ Error pada ${name}:`, e.message);
        }

        summary.push(report);
    }

    console.log('\n================================================================================');
    console.log('                     RINGKASAN EKSTRAKSI DEEP PROVIDER                          ');
    console.log('================================================================================');
    console.table(summary);
    console.log('================================================================================\n');

    return summary;
}

import { fileURLToPath } from 'url';
import fs from 'fs';
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
    runDeepExtractionCheck().then(() => process.exit(0)).catch(err => {
        console.error('Error saat menjalankan deep check:', err);
        process.exit(1);
    });
}
