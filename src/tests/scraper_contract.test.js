process.env.NODE_ENV = 'test';
process.env.NODE_TEST_CONTEXT = 'true';
import test from 'node:test';
import assert from 'node:assert';
import {
    validateEpisodeCatalogContract,
    validateServersContract,
    assertAndRespondContract,
    ScraperContractError,
    SilentFailureError
} from '../utils/contractValidator.js';

test('Scraper Contract Validation: validateEpisodeCatalogContract (Valid Schema)', () => {
    const validData = {
        judul_seri: 'Re:Zero kara Hajimeru Isekai Seikatsu',
        cover_scraper: 'https://kuronime.sbs/wp-content/uploads/rezero.jpg',
        daftar_episode: [
            {
                judul: 'Episode 1',
                url: 'https://kuronime.sbs/nonton-re-zero-episode-1/',
                slug: 're-zero-episode-1'
            },
            {
                judul: 'Episode 2',
                url: 'https://kuronime.sbs/nonton-re-zero-episode-2/',
                slug: 're-zero-episode-2'
            }
        ]
    };

    assert.doesNotThrow(() => {
        validateEpisodeCatalogContract(validData, 'Kuronime');
    });
});

test('Scraper Contract Validation: Silent Failure Guard for Empty Episode List (0 episodes)', () => {
    const emptyData = {
        judul_seri: 'Re:Zero kara Hajimeru Isekai Seikatsu',
        cover_scraper: 'https://kuronime.sbs/wp-content/uploads/rezero.jpg',
        daftar_episode: []
    };

    assert.throws(() => {
        validateEpisodeCatalogContract(emptyData, 'Kuronime');
    }, (err) => {
        assert.ok(err instanceof SilentFailureError || err instanceof ScraperContractError);
        assert.strictEqual(err.code, 'ERR_SILENT_FAILURE_EMPTY_PAYLOAD');
        return true;
    });
});

test('Scraper Contract Validation: Missing required title or malformed schema', () => {
    const malformedData = {
        judul_seri: '',
        daftar_episode: [{ judul: 'Eps 1', url: 'https://...' }]
    };

    assert.throws(() => {
        validateEpisodeCatalogContract(malformedData, 'Otakudesu');
    }, (err) => {
        assert.ok(err instanceof ScraperContractError);
        return true;
    });
});

test('Scraper Contract Validation: validateServersContract (Valid Stream Links & Iframe)', () => {
    const validServers = {
        judul: 'Re:Zero Episode 1 Subtitle Indonesia',
        nav_prev: null,
        nav_next: 'https://kuronime.sbs/nonton-re-zero-episode-2/',
        servers: [
            {
                nama: 'Krakenfiles 720p',
                iframeUrl: 'https://krakenfiles.com/embed-video/xyz',
                provider: 'Krakenfiles',
                aktif: true
            },
            {
                nama: 'Blogger 1080p',
                url: 'https://www.blogger.com/video.g?token=abc',
                provider: 'Blogger',
                aktif: true
            }
        ]
    };

    assert.doesNotThrow(() => {
        validateServersContract(validServers, 'Samehadaku');
    });
});

test('Scraper Contract Validation: Silent Failure Guard for Empty Servers List (0 servers)', () => {
    const emptyServers = {
        judul: 'Re:Zero Episode 1 Subtitle Indonesia',
        servers: []
    };

    assert.throws(() => {
        validateServersContract(emptyServers, 'Otakudesu');
    }, (err) => {
        assert.ok(err instanceof SilentFailureError || err instanceof ScraperContractError);
        assert.strictEqual(err.code, 'ERR_SILENT_FAILURE_EMPTY_PAYLOAD');
        return true;
    });
});

test('Scraper Contract Validation: Error Response Title from Scraper ("Error: Timeout/CF")', () => {
    const errorScraperRes = {
        judul: 'Error: Cloudflare Blocked or Page Not Found',
        servers: [],
        debug_info: 'Timeout 30000ms exceeded'
    };

    assert.throws(() => {
        validateServersContract(errorScraperRes, 'Oploverz');
    }, (err) => {
        assert.ok(err instanceof SilentFailureError);
        assert.strictEqual(err.code, 'ERR_SILENT_FAILURE_EMPTY_PAYLOAD');
        return true;
    });
});

test('Express Middleware Helper: assertAndRespondContract produces HTTP 502 instead of 200 on Silent Failure', () => {
    let statusCode = null;
    let jsonPayload = null;

    const mockRes = {
        headersSent: false,
        status(code) {
            statusCode = code;
            return this;
        },
        json(payload) {
            jsonPayload = payload;
            return this;
        }
    };

    const silentFailurePayload = {
        judul: 'Naruto Shippuden Episode 500',
        servers: [] // Empty server payload due to site layout change
    };

    const isValid = assertAndRespondContract(mockRes, silentFailurePayload, 'servers', 'Otakudesu');

    assert.strictEqual(isValid, false, 'assertAndRespondContract should return false when contract check fails');
    assert.strictEqual(statusCode, 502, 'Should respond with HTTP 502 Bad Gateway instead of HTTP 200 OK');
    assert.strictEqual(jsonPayload.status, 'error');
    assert.strictEqual(jsonPayload.code, 'ERR_SILENT_FAILURE_EMPTY_PAYLOAD');
    assert.strictEqual(jsonPayload.provider, 'Otakudesu');
});
