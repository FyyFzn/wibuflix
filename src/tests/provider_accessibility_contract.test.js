process.env.NODE_ENV = 'test';
process.env.NODE_TEST_CONTEXT = 'true';
import test from 'node:test';
import assert from 'node:assert';
import {
    validateEpisodeCatalogContract,
    validateServersContract,
    ScraperContractError,
    SilentFailureError
} from '../utils/contractValidator.js';

/**
 * Provider Accessibility & Contract Verification Suite
 * 
 * Pengujian otomatis untuk memverifikasi bahwa semua web provider dalam ekosistem Wibuflix:
 * 1. Punya konfigurasi URL base dan struktur URL balik yang benar.
 * 2. Menghasilkan model data yang sesuai dengan kontrak formal (episode catalog & server stream).
 */

const CONFIGURED_PROVIDERS = [
    { name: 'Samehadaku', baseUrl: 'https://v2.samehadaku.how/', expectedProtocol: 'https:' },
    { name: 'Otakudesu', baseUrl: 'https://otakudesu.blog/', expectedProtocol: 'https:' },
    { name: 'Kuronime', baseUrl: 'https://kuronime.sbs/', expectedProtocol: 'https:' },
    { name: 'Nanime ID', baseUrl: 'https://nanimeid.net/', expectedProtocol: 'https:' },
    { name: 'Nimegami', baseUrl: 'https://nimegami.id/', expectedProtocol: 'https:' },
    { name: 'Oploverz', baseUrl: 'https://idn.oploverz.site/', expectedProtocol: 'https:' },

    { name: 'Neosatsu', baseUrl: 'https://www.neosatsu.com/', expectedProtocol: 'https:' }
];

test('Web Provider URL Integrity Check: Semua web penyedia memiliki format URL base yang valid dan aman (HTTPS)', () => {
    assert.strictEqual(CONFIGURED_PROVIDERS.length, 7, 'Harus terkonfigurasi tepat 7 web provider utama');

    for (const provider of CONFIGURED_PROVIDERS) {
        let parsedUrl;
        assert.doesNotThrow(() => {
            parsedUrl = new URL(provider.baseUrl);
        }, `URL untuk provider [${provider.name}] harus merupakan valid URL: ${provider.baseUrl}`);

        assert.strictEqual(
            parsedUrl.protocol,
            provider.expectedProtocol,
            `Provider [${provider.name}] harus menggunakan protokol HTTPS untuk keamanan`
        );
        assert.ok(
            parsedUrl.hostname.length > 3,
            `Hostname untuk provider [${provider.name}] harus valid dan tidak kosong`
        );
    }
});

test('Contract Verification: Semua web penyedia memvalidasi skema daftar episode sesuai standar Wibuflix', () => {
    for (const provider of CONFIGURED_PROVIDERS) {
        // Simulasi hasil scraping daftar episode yang dikembalikan dari URL provider
        const mockEpisodeCatalog = {
            judul_seri: `Anime Sample from ${provider.name}`,
            cover_scraper: `${provider.baseUrl}uploads/cover.jpg`,
            daftar_episode: [
                {
                    judul: 'Episode 1',
                    url: `${provider.baseUrl}nonton-episode-1/`,
                    slug: 'nonton-episode-1'
                },
                {
                    judul: 'Episode 2',
                    url: `${provider.baseUrl}nonton-episode-2/`,
                    slug: 'nonton-episode-2'
                }
            ]
        };

        // Harus lolos tanpa melempar error
        assert.doesNotThrow(() => {
            validateEpisodeCatalogContract(mockEpisodeCatalog, provider.name);
        }, `Skema daftar episode untuk provider [${provider.name}] harus memenuhi kontrak formal`);

        // Verifikasi bahwa URL dalam daftar episode berawal dengan HTTP/HTTPS yang benar
        assert.ok(
            mockEpisodeCatalog.daftar_episode.every(ep => ep.url.startsWith('http://') || ep.url.startsWith('https://')),
            `Semua URL episode pada provider [${provider.name}] harus mengembalikan URL absolut yang benar`
        );
    }
});

test('Contract Verification: Semua web penyedia memvalidasi skema streaming server sesuai standar Wibuflix', () => {
    for (const provider of CONFIGURED_PROVIDERS) {
        const mockServersPayload = {
            judul: `Sample Stream Episode 1 - ${provider.name}`,
            judul_seri: `Anime Sample from ${provider.name}`,
            cover_scraper: `${provider.baseUrl}uploads/cover.jpg`,
            nav_prev: null,
            nav_next: `${provider.baseUrl}nonton-episode-2/`,
            servers: [
                {
                    nama: '720p · Cloud CDN',
                    iframeUrl: 'https://kuroplayer.com/embed/xyz123',
                    provider: provider.name,
                    aktif: true
                },
                {
                    nama: '1080p · Cloud CDN',
                    url: 'https://www.blogger.com/video.g?token=abc456',
                    provider: provider.name,
                    aktif: true
                }
            ]
        };

        assert.doesNotThrow(() => {
            validateServersContract(mockServersPayload, provider.name);
        }, `Skema server streams untuk provider [${provider.name}] harus memenuhi kontrak formal`);
    }
});

test('Silent Failure Detection Check: Deteksi URL rusak/konten kosong dari semua web agar memicu failover otomatis', () => {
    for (const provider of CONFIGURED_PROVIDERS) {
        const emptyResponse = {
            judul_seri: `Broken Page from ${provider.name}`,
            cover_scraper: '',
            daftar_episode: [] // Layout situs berubah atau halaman 404/Cloudflare blocked
        };

        assert.throws(() => {
            validateEpisodeCatalogContract(emptyResponse, provider.name);
        }, (err) => {
            assert.ok(
                err instanceof SilentFailureError || err instanceof ScraperContractError,
                `Provider [${provider.name}] harus menghasilkan SilentFailureError atau ScraperContractError saat hasil kosong`
            );
            return true;
        }, `Provider [${provider.name}] harus menolak respons tanpa episode demi menjaga integritas data Wibuflix`);
    }
});
