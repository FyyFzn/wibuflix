process.env.NODE_ENV = 'test';
process.env.NODE_TEST_CONTEXT = 'true';
import test from 'node:test';
import assert from 'node:assert';
import {
    PROVIDER_URLS,
    PROVIDER_LIST,
    getProviderSeriesUrl,
    isProviderUrl
} from '../config/providerUrls.js';

/**
 * Provider URL Completeness Verification Suite
 * 
 * Pengujian otomatis untuk memastikan seluruh 7 web provider mampu menghasilkan
 * URL absolut dan lengkap (https://...) untuk halaman detail anime, katalog, dan pembentukan URL episode.
 */

test('Provider Series & Detail URL Completeness: Semua provider menghasilkan URL absolut lengkap untuk detail anime', () => {
    const testSlug = 'naruto-shippuden';
    const providerKeys = Object.keys(PROVIDER_URLS);

    assert.strictEqual(providerKeys.length, 7, 'Harus terdapat tepat 7 provider di PROVIDER_URLS');

    for (const key of providerKeys) {
        const provider = PROVIDER_URLS[key];
        const seriesUrl = getProviderSeriesUrl(key, testSlug);

        assert.ok(seriesUrl, `Provider [${provider.NAME}] (${key}) harus mengembalikan URL series yang tidak kosong`);
        assert.ok(
            seriesUrl.startsWith('https://') || seriesUrl.startsWith('http://'),
            `URL series untuk provider [${provider.NAME}] harus berupa URL absolut yang diawali HTTP/HTTPS: ${seriesUrl}`
        );
        assert.ok(
            !seriesUrl.includes('//anime//') && !seriesUrl.includes('https:////'),
            `URL series untuk provider [${provider.NAME}] tidak boleh memiliki double slash ilegal: ${seriesUrl}`
        );
        assert.ok(
            seriesUrl.includes(testSlug),
            `URL series untuk provider [${provider.NAME}] harus memuat slug anime [${testSlug}]: ${seriesUrl}`
        );

        let parsedUrl;
        assert.doesNotThrow(() => {
            parsedUrl = new URL(seriesUrl);
        }, `URL series [${seriesUrl}] pada provider [${provider.NAME}] harus valid secara sintaksis URL`);

        assert.ok(parsedUrl.hostname.length > 3, `Hostname provider [${provider.NAME}] harus valid`);
    }
});

test('Provider Catalog & Base URL Completeness: Semua provider memiliki atribut BASE_URL, CATALOG_URL, dan NAME yang lengkap', () => {
    for (const provider of PROVIDER_LIST) {
        assert.ok(provider.NAME, 'Properti NAME wajib ada dan tidak kosong');
        assert.ok(provider.BASE_URL, `Provider [${provider.NAME}] wajib memiliki BASE_URL`);
        assert.ok(provider.CATALOG_URL, `Provider [${provider.NAME}] wajib memiliki CATALOG_URL`);

        assert.ok(
            provider.BASE_URL.startsWith('https://') || provider.BASE_URL.startsWith('http://'),
            `BASE_URL provider [${provider.NAME}] harus berupa URL absolut lengkap: ${provider.BASE_URL}`
        );
        assert.ok(
            provider.CATALOG_URL.startsWith('https://') || provider.CATALOG_URL.startsWith('http://'),
            `CATALOG_URL provider [${provider.NAME}] harus berupa URL absolut lengkap: ${provider.CATALOG_URL}`
        );
    }
});

test('Dynamic URL Generation Verification: getProviderSeriesUrl menghasilkan URL absolut yang akurat berdasarkan SERIES_PATH', () => {
    const slug = 'kamen-rider-gavv';

    assert.strictEqual(getProviderSeriesUrl('SAMEHADAKU', slug), `${PROVIDER_URLS.SAMEHADAKU.BASE_URL}/anime/${slug}/`);
    assert.strictEqual(getProviderSeriesUrl('OTAKUDESU', slug), `${PROVIDER_URLS.OTAKUDESU.BASE_URL}/anime/${slug}/`);
    assert.strictEqual(getProviderSeriesUrl('KURONIME', slug), `${PROVIDER_URLS.KURONIME.BASE_URL}/anime/${slug}/`);
    assert.strictEqual(getProviderSeriesUrl('NANIME', slug), `${PROVIDER_URLS.NANIME.BASE_URL}/anime/${slug}`);
    assert.strictEqual(getProviderSeriesUrl('NIMEGAMI', slug), `${PROVIDER_URLS.NIMEGAMI.BASE_URL}/${slug}/`);
    assert.strictEqual(getProviderSeriesUrl('OPLOVERZ', slug), `${PROVIDER_URLS.OPLOVERZ.BASE_URL}/series/${slug}`);
    assert.strictEqual(getProviderSeriesUrl('NEOSATSU', slug), `${PROVIDER_URLS.NEOSATSU.BASE_URL}/2024/01/${slug}.html`);
});

test('Provider Domain Recognition: isProviderUrl mengenali domain absolut dan menolak URL relatif atau rusak', () => {
    const oploverzAbsUrl = 'https://idn.oploverz.site/series/one-piece';
    assert.strictEqual(isProviderUrl(oploverzAbsUrl, 'OPLOVERZ'), true);

    const relativeUrl = '/nonton-anime/episode-1/';
    assert.strictEqual(isProviderUrl(relativeUrl, 'SAMEHADAKU'), false);
    assert.strictEqual(isProviderUrl(null, 'KURONIME'), false);
});
