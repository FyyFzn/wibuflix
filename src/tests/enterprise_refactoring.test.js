import test from 'node:test';
import assert from 'node:assert';

// 1. Domain Services Imports
import { resolveCanonicalUniqueId, canonicalTitleMap } from '../services/canonicalService.js';
import { extractSlugs } from '../services/slugService.js';
import { serverScore, getResolutionGroup } from '../services/streamRankingService.js';
import { getUploadProgress, getActiveUploadCount } from '../services/stream/uploadProgressService.js';
import { cleanTitle } from '../services/scrapers/neosatsu/neosatsuShared.js';

// 2. Facade Compatibility Imports
import * as extractRouteFacade from '../routes/extract.js';
import * as azureUploaderFacade from '../utils/azureUploader.js';
import * as neosatsuControllerFacade from '../controllers/neosatsuController.js';

test('Tahap 1: Canonical Service - resolveCanonicalUniqueId deterministic identification', async () => {
    // Pre-seed map to avoid Mongoose timeout in unit tests without DB connection
    canonicalTitleMap.set('mal-20', 'naruto-shippuden');
    
    const id1 = await resolveCanonicalUniqueId('https://samehadaku.email/anime/naruto', null, 'Naruto Shippuden', 'mal-20');
    assert.strictEqual(id1, 'mal-20');
    assert.strictEqual(canonicalTitleMap.get('mal-20'), 'naruto-shippuden');
});

test('Tahap 1: Slug Service - extractSlugs URL normalization', () => {
    const res = extractSlugs(
        'https://samehadaku.email/naruto-episode-1',
        'https://samehadaku.email/anime/naruto',
        'Naruto Shippuden',
        'mal-20'
    );
    assert.strictEqual(res.seriesSlug, 'mal-20_naruto-shippuden');
    assert.strictEqual(res.episodeSlug, 'episode-1');

    // Without uniqueId
    const resNoId = extractSlugs(
        'https://samehadaku.email/naruto-episode-1',
        'https://samehadaku.email/anime/naruto',
        'Naruto Shippuden',
        null
    );
    assert.ok(resNoId.seriesSlug.includes('naruto'));
    assert.strictEqual(resNoId.episodeSlug, 'episode-1');
});

test('Tahap 1: Stream Ranking Service - resolution grouping and server scoring', () => {
    // Resolution grouping check
    assert.strictEqual(getResolutionGroup('Full HD 1080p'), 1080);
    assert.strictEqual(getResolutionGroup('720p HD'), 720);
    assert.strictEqual(getResolutionGroup('480p'), 480);
    assert.strictEqual(getResolutionGroup('x265 1080p HEVC'), null); // Should reject HEVC for mobile performance

    // Server score ranking check
    const megaScore = serverScore('mega.nz');
    const wibuScore = serverScore('wibufile.com');
    const krakenScore = serverScore('kuroplayer.com');

    assert.ok(wibuScore > krakenScore, 'Wibufile should rank higher than slow/dead Kuroplayer');
});

test('Tahap 2: Stream Progress Service - in-memory upload progress state tracking', () => {
    const progress = getUploadProgress('mal-20_naruto', 'episode-1');
    assert.strictEqual(progress, 'Menyiapkan video...');
    
    const activeCount = getActiveUploadCount();
    assert.strictEqual(typeof activeCount, 'number');
});

test('Tahap 3: Neosatsu Scraper Shared - cleanTitle utility', () => {
    const cleaned = cleanTitle('Kamen Rider Gavv Episode 12 Subtitle Indonesia');
    assert.ok(!cleaned.includes('Subtitle Indonesia'));
});

test('Tahap 1-3: Facade Backward Compatibility Verification', () => {
    // 1. extract.js route facade should still export legacy functions
    assert.strictEqual(typeof extractRouteFacade.extractSlugs, 'function');
    assert.strictEqual(typeof extractRouteFacade.resolveCanonicalUniqueId, 'function');
    assert.strictEqual(typeof extractRouteFacade.prefetchOneEpisode, 'function');

    // 2. azureUploader.js facade should still export legacy functions
    assert.strictEqual(typeof azureUploaderFacade.getUploadProgress, 'function');
    assert.strictEqual(typeof azureUploaderFacade.getBlobPath, 'function');
    assert.strictEqual(typeof azureUploaderFacade.checkRangeSupport, 'function');
    assert.strictEqual(typeof azureUploaderFacade.uploadStream, 'function');

    // 3. neosatsuController.js facade should still export legacy functions
    assert.strictEqual(typeof neosatsuControllerFacade.getNeosatsuCatalog, 'function');
    assert.strictEqual(typeof neosatsuControllerFacade.getNeosatsuEpisodes, 'function');
    assert.strictEqual(typeof neosatsuControllerFacade.getNeosatsuServers, 'function');
    assert.ok(neosatsuControllerFacade.cache);
});
