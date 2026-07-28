import { ProviderRegistry } from '../services/ProviderRegistry.js';
import mongoose from 'mongoose';
import Anime from '../models/Anime.js';
import { fileURLToPath } from 'url';
import fs from 'fs';
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
 * Diagnostic Deep Extraction Check (Dynamic Version)
 * 
 * Mengecek secara otomatis SEMUA web provider yang terdaftar di sistem.
 * Skrip ini tidak memuat fungsi scraper statis. Ia murni memanfaatkan 
 * metode `fetchLatestUpdates`, `fetchEpisodes`, dan `fetchServers` 
 * dari arsitektur ProviderRegistry.
 */
export async function runDeepExtractionCheck() {
    console.log('\n================================================================================');
    console.log('                 WIBUFLIX DEEP EXTRACTION & DOWNLOAD LINK CHECK                 ');
    console.log('================================================================================');
    console.log('Memeriksa pengambilan Detail Anime, Daftar Episode, & Link Stream/Download secara dinamis...\n');

    const providerIds = await ProviderRegistry.getAllProviderIds();
    const summary = [];

    for (const pid of providerIds) {
        const details = await ProviderRegistry.getProviderDetails(pid);
        const name = details ? details.name : pid;
        
        console.log(`--------------------------------------------------------------------------------`);
        console.log(`[>>] Menguji Provider: ${name} (ID: ${pid})`);
        
        const report = {
            Provider: name,
            Detail_Anime_Judul: '-',
            Total_Episode: 0,
            Detail_Episode_Judul: '-',
            Total_Server_Link: 0,
            Status_Akhir: 'GAGAL'
        };

        try {
            // 1. Ambil URL sample statis (Katalog Series)
            // Kita tidak menggunakan fetchLatestUpdates() karena beberapa plugin mengembalikan URL halaman Episode (bukan Series),
            // yang akan membuat fetchEpisodes() gagal.
            const getFallbackUrl = (id) => {
                if (id === 'samehadaku') return `${PROVIDER_URLS.SAMEHADAKU.BASE_URL}/anime/naruto-shippuden/`;
                if (id === 'otakudesu') return `${PROVIDER_URLS.OTAKUDESU.BASE_URL}/anime/compass-20-sub-indo/`;
                if (id === 'kuronime') return `${PROVIDER_URLS.KURONIME.BASE_URL}/anime/bleach-thousand-year-blood-war/`;
                if (id === 'nanime') return `${PROVIDER_URLS.NANIME.BASE_URL}/anime/one-piece`;
                if (id === 'nimegami') return `${PROVIDER_URLS.NIMEGAMI.BASE_URL}/dr-stone-new-world-sub-indo/`;
                if (id === 'oploverz') return `${PROVIDER_URLS.OPLOVERZ.BASE_URL}/series/one-piece`;
                if (id === 'neosatsu') return `${PROVIDER_URLS.NEOSATSU.BASE_URL}/2024/09/kamen-rider-gavv-sub-indo.html`;
                return null;
            };
            
            const animeUrl = getFallbackUrl(pid);

            if (!animeUrl) {
                console.log(`     ⚠️ Gagal mendapatkan sample URL fallback. Melewati...`);
                report.Status_Akhir = 'NO_SAMPLE_URL';
                summary.push(report);
                continue;
            }

            console.log(`     -> Sample Anime URL: ${animeUrl}`);

            // 2. Uji Detail Anime & Daftar Episode
            const epCatalog = await ProviderRegistry.fetchEpisodes(animeUrl);

            if (epCatalog && epCatalog.daftar_episode && epCatalog.daftar_episode.length > 0) {
                report.Detail_Anime_Judul = epCatalog.judul_seri || 'Terambil';
                report.Total_Episode = epCatalog.daftar_episode.length;
                console.log(`     ✅ Detail Anime sukses: "${report.Detail_Anime_Judul}" (${report.Total_Episode} episode terdeteksi)`);

                // 3. Uji Detail Episode & Link Download/Server Stream
                const sampleEp = epCatalog.daftar_episode.find(ep => !ep.judul.toLowerCase().includes('batch') && (!ep.url || !ep.url.includes('/batch/'))) || epCatalog.daftar_episode[0];
                const epUrl = sampleEp.url || sampleEp.slug;
                console.log(`     -> Menguji Ekstraksi Link Episode: "${sampleEp.judul}" (${epUrl})...`);

                const serverData = await ProviderRegistry.fetchServers(epUrl);

                if (serverData && serverData.servers && serverData.servers.length > 0) {
                    report.Detail_Episode_Judul = serverData.judul || sampleEp.judul;
                    report.Total_Server_Link = serverData.servers.length;
                    report.Status_Akhir = 'BERHASIL & LENGKAP';
                    console.log(`     ✅ Detail Episode & Link Stream/Download sukses! Ditemukan ${report.Total_Server_Link} server/mirror link.`);
                    console.log(`        Contoh Server: ${serverData.servers.slice(0, 3).map(s => '[' + (s.nama || s.provider || 'Direct') + ']').join(', ')}`);
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

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
    runDeepExtractionCheck().then(() => process.exit(0)).catch(err => {
        console.error('Error saat menjalankan deep check:', err);
        process.exit(1);
    });
}
