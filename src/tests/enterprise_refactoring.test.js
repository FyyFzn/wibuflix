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

test('Tahap 1: OVA/Special Episode - stringUtils and slugService separation', async () => {
    const { extractEpNumStrict, extractEpNum } = await import('../utils/stringUtils.js');

    assert.strictEqual(extractEpNumStrict('Accel World OVA 1'), null);
    assert.strictEqual(extractEpNumStrict('Accel World Special 2'), null);
    assert.strictEqual(extractEpNumStrict('Accel World SP 1'), null);
    assert.strictEqual(extractEpNumStrict('Accel World Episode 1'), 1);

    assert.strictEqual(extractEpNum('Accel World OVA 1'), null);
    assert.strictEqual(extractEpNum('Accel World Special 2'), null);
    assert.strictEqual(extractEpNum('Accel World SP 1'), null);
    assert.strictEqual(extractEpNum('Accel World Episode 1'), 1);

    // Check extractSlugs for OVA/Special/SP/OAD
    const resOva = extractSlugs(
        'https://samehadaku.email/accel-world-ova-01',
        'https://samehadaku.email/anime/accel-world',
        'Accel World',
        'mal-11759',
        'Episode OVA 1'
    );
    assert.strictEqual(resOva.episodeSlug, 'ova-1');
    assert.ok(resOva.episodeSlugsToCheck.includes('ova-1'));

    const resOvaSlug = extractSlugs(
        'https://samehadaku.email/accel-world-ova-02-sub-indo',
        'https://samehadaku.email/anime/accel-world',
        'Accel World',
        'mal-11759',
        ''
    );
    assert.strictEqual(resOvaSlug.episodeSlug, 'ova-2');
    assert.ok(resOvaSlug.episodeSlugsToCheck.includes('ova-2'));

    const resSpecial = extractSlugs(
        'https://samehadaku.email/accel-world-special-1',
        'https://samehadaku.email/anime/accel-world',
        'Accel World',
        'mal-11759',
        'Special 1'
    );
    assert.strictEqual(resSpecial.episodeSlug, 'special-1');
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

test('Tahap 5: Actual Source Provider Tracking - reportBrokenV2 reads actual source from uploadCache', async () => {
    const { uploadCache } = await import('../services/stream/streamStateStore.js');
    const { reportBrokenV2 } = await import('../controllers/v2StreamController.js');
    const { isEpisodeProviderBlacklisted } = await import('../services/streamRankingService.js');

    // 1. Seed uploadCache with actual video source provider for a specific episode
    const seriesSlug = 'mal-11759_accel-world';
    const episodeSlug = 'episode-1';
    uploadCache.set(`blob_source_prov_${seriesSlug}_${episodeSlug}`, 'samehadaku');

    // 2. Mock Express Request & Response for reportBrokenV2
    // Even if targetUrl points to otakudesu, it should blacklist samehadaku because that is the actual source stored in uploadCache!
    let responsePayload = null;
    const mockReq = {
        query: {
            url: 'https://otakudesu.cloud/accel-world-episode-1/',
            seriesUrl: 'https://otakudesu.cloud/anime/accel-world',
            seriesTitle: 'Accel World',
            episodeTitle: 'Accel World Episode 1',
            uniqueId: 'mal-11759'
        },
        headers: {},
        socket: {}
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

    await reportBrokenV2(mockReq, mockRes);

    // 3. Verify that samehadaku (not otakudesu) is blacklisted for this episode
    const isSamehadakuBlacklisted = isEpisodeProviderBlacklisted('samehadaku', { seriesSlug, episodeSlug });
    const isOtakudesuBlacklisted = isEpisodeProviderBlacklisted('otakudesu', { seriesSlug, episodeSlug });

    assert.strictEqual(isSamehadakuBlacklisted, true, 'Samehadaku should be blacklisted as the actual source provider');
    assert.strictEqual(isOtakudesuBlacklisted, false, 'Otakudesu should not be blacklisted since it was not the actual source');
});

test('Tahap 6: OVA/Special Contamination Sanitization & Strict Number Extraction', async () => {
    const { extractEpNumStrict } = await import('../utils/stringUtils.js');
    const { sanitizeContaminatedEpisodeCards } = await import('../services/episodeService.js');

    // 1. Verify strict number extraction rejects EX and parenthesized OVA
    assert.strictEqual(extractEpNumStrict('Accel World - EX 1'), null, 'EX episode should return null');
    assert.strictEqual(extractEpNumStrict('Accel World - 01 (OVA)'), null, 'Parenthesized OVA should return null');
    assert.strictEqual(extractEpNumStrict('Accel World Episode 1'), 1, 'Normal episode should return 1');

    // 2. Verify sanitizeContaminatedEpisodeCards cleans up contaminated episode cards
    const contaminatedList = [
        {
            judul: 'Accel World Episode 1',
            num: 1,
            urls: {
                samehadaku: 'https://samehadaku.email/accel-world-episode-1/',
                otakudesu: 'https://otakudesu.cloud/accel-world-ova-1/' // Contaminated URL inside normal card!
            }
        },
        {
            judul: 'Accel World OVA 1',
            num: 1, // Contaminated num assigned to OVA card!
            urls: {
                otakudesu: 'https://otakudesu.cloud/accel-world-ova-1/'
            }
        }
    ];

    const cleanedList = sanitizeContaminatedEpisodeCards(contaminatedList);

    // Normal card should have otakudesu OVA url stripped out
    assert.strictEqual(cleanedList[0].urls.samehadaku, 'https://samehadaku.email/accel-world-episode-1/');
    assert.strictEqual(cleanedList[0].urls.otakudesu, undefined, 'Contaminated OVA url should be removed from normal Ep 1 card');

    // OVA card should have num reset to null
    assert.strictEqual(cleanedList[1].num, null, 'OVA card with contaminated num: 1 should be reset to num: null');
});

