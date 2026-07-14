import test from 'node:test';
import assert from 'node:assert';
import { ProviderRegistry, standardizeServers } from '../services/ProviderRegistry.js';

test('ProviderRegistry Architecture Verification', async (t) => {
    await t.test('1. Semua Provider Terdaftar dengan Lengkap di ProviderRegistry', () => {
        const ids = ProviderRegistry.getAllProviderIds();
        assert.ok(ids.includes('samehadaku'), 'Samehadaku wajib terdaftar');
        assert.ok(ids.includes('otakudesu'), 'Otakudesu wajib terdaftar');
        assert.ok(ids.includes('kuronime'), 'Kuronime wajib terdaftar');
        assert.ok(ids.includes('nanime'), 'Nanime wajib terdaftar');
        assert.ok(ids.includes('nimegami'), 'Nimegami wajib terdaftar');
        assert.ok(ids.includes('oploverz'), 'Oploverz wajib terdaftar');
        assert.ok(ids.includes('neosatsu'), 'Neosatsu wajib terdaftar');
    });

    await t.test('2. getProviderForUrl mengidentifikasi provider dengan akurat tanpa if-else manual', () => {
        assert.strictEqual(ProviderRegistry.getProviderForUrl('https://plus.oploverz.ltd/series/inuyasha-s1').id, 'oploverz');
        assert.strictEqual(ProviderRegistry.getProviderForUrl('https://kuronime.sbs/inuyasha-s1-episode-1').id, 'kuronime');
        assert.strictEqual(ProviderRegistry.getProviderForUrl('https://otakudesu.cloud/anime/inuyasha-sub-indo/').id, 'otakudesu');
        assert.strictEqual(ProviderRegistry.getProviderForUrl('___neosatsu_ep___https://neosatsu.com/ep-1').id, 'neosatsu');
        assert.strictEqual(ProviderRegistry.getProviderForUrl('https://samehadaku.email/inuyasha-episode-1/').id, 'samehadaku');
    });

    await t.test('3. standardizeServers menjamin konsistensi properti (id vs nume, tipe vs type)', () => {
        const rawServers = [
            { id: 'srv-1', tipe: 'embed', url: 'https://player.com/v/123', provider: 'FILEDON' },
            { nume: 'srv-2', type: 'direct', iframeUrl: 'https://player.com/v/456', namaHost: 'PIXELDRAIN' }
        ];

        const standardized = standardizeServers(rawServers, 'TestProv');
        assert.strictEqual(standardized.length, 2);

        // Pastikan item pertama punya kedua versi nama properti
        assert.strictEqual(standardized[0].id, 'srv-1');
        assert.strictEqual(standardized[0].nume, 'srv-1');
        assert.strictEqual(standardized[0].type, 'embed');
        assert.strictEqual(standardized[0].tipe, 'embed');
        assert.strictEqual(standardized[0].url, 'https://player.com/v/123');
        assert.strictEqual(standardized[0].iframeUrl, 'https://player.com/v/123');
        assert.strictEqual(standardized[0].provider, 'FILEDON');
        assert.strictEqual(standardized[0].namaHost, 'FILEDON');
        assert.strictEqual(standardized[0].source, 'TestProv');

        // Pastikan item kedua punya kedua versi nama properti
        assert.strictEqual(standardized[1].id, 'srv-2');
        assert.strictEqual(standardized[1].nume, 'srv-2');
        assert.strictEqual(standardized[1].type, 'direct');
        assert.strictEqual(standardized[1].tipe, 'direct');
        assert.strictEqual(standardized[1].url, 'https://player.com/v/456');
        assert.strictEqual(standardized[1].iframeUrl, 'https://player.com/v/456');
        assert.strictEqual(standardized[1].provider, 'PIXELDRAIN');
        assert.strictEqual(standardized[1].namaHost, 'PIXELDRAIN');
        assert.strictEqual(standardized[1].source, 'TestProv');
    });
});
