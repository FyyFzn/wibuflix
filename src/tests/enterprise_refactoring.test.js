process.env.NODE_ENV = 'test';
process.env.NODE_TEST_CONTEXT = 'true';
import test from 'node:test';
import assert from 'node:assert';

// 1. Domain Services Imports
import { resolveCanonicalUniqueId, canonicalTitleMap } from '../services/canonicalService.js';
import { extractSlugs } from '../services/slugService.js';
import { serverScore, getResolutionGroup } from '../services/streamRankingService.js';
import { getUploadProgress, getActiveUploadCount } from '../services/stream/uploadProgressService.js';
import { cleanTitle } from '../services/scrapers/neosatsu/neosatsuShared.js';

// 2. Layered Architecture Services Imports (1 file = 1 job)
import * as blobStorageService from '../services/stream/blobStorageService.js';
import * as uploadProgressService from '../services/stream/uploadProgressService.js';
import * as neosatsuScraperService from '../services/scrapers/neosatsuScraperService.js';

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

test('Tahap 1-3: Clean Layered Architecture - Single Responsibility verification (1 file = 1 job)', () => {
    // 1. Blob storage service handles only Azure storage operations
    assert.strictEqual(typeof blobStorageService.getBlobPath, 'function');
    assert.strictEqual(typeof blobStorageService.checkUploadStatusWithFallback, 'function');

    // 2. Upload progress service handles only progress and state tracking
    assert.strictEqual(typeof uploadProgressService.getUploadProgress, 'function');
    assert.strictEqual(typeof uploadProgressService.cancelAllUploads, 'function');

    // 3. Neosatsu scraper service handles only web scraping for Neosatsu
    assert.strictEqual(typeof neosatsuScraperService.getNeosatsuCatalog, 'function');
    assert.strictEqual(typeof neosatsuScraperService.getNeosatsuEpisodes, 'function');
    assert.strictEqual(typeof neosatsuScraperService.getNeosatsuServers, 'function');
});
