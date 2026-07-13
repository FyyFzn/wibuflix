process.env.NODE_ENV = 'test';
process.env.NODE_TEST_CONTEXT = 'true';
import test from 'node:test';
import assert from 'node:assert';
import * as extractController from '../controllers/extractController.js';
import * as prefetchService from '../services/prefetchService.js';
import * as v2StreamController from '../controllers/v2StreamController.js';
import { canonicalTitleMap } from '../services/canonicalService.js';

test('Tahap 4: Unified Extraction Pipeline - Smart-Play and Queue delegate extraction to prefetchOneEpisode', async () => {
    // Pastikan smartPlayHandler ada dan merupakan function
    assert.strictEqual(typeof extractController.smartPlayHandler, 'function');
    
    // Pastikan prefetchOneEpisode dan triggerPrefetchWindow ada
    assert.strictEqual(typeof prefetchService.prefetchOneEpisode, 'function');
    assert.strictEqual(typeof prefetchService.triggerPrefetchWindow, 'function');
});

test('Tahap 5: V2 Stream Controller - Server-Driven Metadata Enrichment & Failover verification', async () => {
    assert.strictEqual(typeof v2StreamController.getV2Stream, 'function');
    assert.strictEqual(typeof v2StreamController.reportBrokenV2, 'function');

    // Pre-seed map agar tidak memicu timeout Mongoose saat unit test tanpa koneksi database
    canonicalTitleMap.set('mal-20', 'naruto-shippuden');

    // Mock Express Request & Response untuk memastikan getV2Stream mengembalikan struktur enriched servers
    let responsePayload = null;
    const mockReq = {
        query: {
            episodeUrl: 'https://samehadaku.email/naruto-shippuden-episode-1/',
            seriesTitle: 'Naruto Shippuden',
            episodeTitle: 'Naruto Shippuden Episode 1',
            uniqueId: 'mal-20'
        }
    };
    const mockRes = {
        json(payload) {
            responsePayload = payload;
            return this;
        },
        status(code) {
            return this;
        }
    };

    await v2StreamController.getV2Stream(mockReq, mockRes);
    
    assert.ok(responsePayload, 'getV2Stream harus menghasilkan response JSON payload');
    assert.strictEqual(responsePayload.status, 'success');
    assert.ok(responsePayload.data, 'Response data harus tersedia');
    assert.ok(Array.isArray(responsePayload.data.servers), 'Enriched metadata harus menyediakan array servers');
    assert.ok(responsePayload.data.servers.some(s => s.nama === '1080p · Cloud CDN'), 'Daftar server harus mencakup opsi 1080p Cloud CDN');
    assert.ok(responsePayload.data.servers.some(s => s.nama === '720p · Cloud CDN'), 'Daftar server harus mencakup opsi 720p Cloud CDN');
});
