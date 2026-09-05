/**
 * Focused diagnostic: Compare exact UA strings used by the backend
 */
const https = require('https');

const TARGET_URL = 'https://s3.animeverse.id/ngentot/v416XVk2.mp4';

function makeRequest(label, headers, method = 'GET') {
    return new Promise((resolve) => {
        const url = new URL(TARGET_URL);
        const opts = {
            hostname: url.hostname,
            path: url.pathname,
            method,
            headers: { ...headers },
            timeout: 6000,
        };

        const req = https.request(opts, (res) => {
            // Don't read body — just consume and drain
            res.resume();
            const ct = res.headers['content-type'] || '';
            const cl = res.headers['content-length'] || '?';
            console.log(`[${res.statusCode}] ${label}`);
            console.log(`       CT: ${ct}  CL: ${cl}`);
            resolve(res.statusCode);
        });

        req.on('timeout', () => {
            console.log(`[TIMEOUT] ${label}`);
            req.destroy();
            resolve('TIMEOUT');
        });

        req.on('error', (e) => {
            console.log(`[ERROR] ${label}: ${e.message}`);
            resolve('ERROR');
        });

        req.end();
    });
}

async function run() {
    console.log(`\nDiagnosing: ${TARGET_URL}\n`);

    // The CORRECT Chrome UA used in most places
    await makeRequest('Correct UA: Chrome/124.0.0.0 Safari/537.36', {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    // The BUGGY UA in ffmpegStreamService (Safari version wrong: 124.0.0.0 instead of 537.36)
    await makeRequest('Buggy UA: Chrome/124.0.0.0 Safari/124.0.0.0 (ffmpegStreamService)', {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/124.0.0.0',
    });

    // No UA at all
    await makeRequest('No User-Agent', {});

    // HEAD requests
    await makeRequest('HEAD + correct UA', {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    }, 'HEAD');

    // HEAD with range
    await makeRequest('HEAD + Range', {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Range': 'bytes=0-0',
    }, 'HEAD');

    // GET with range (simulates checkRangeSupport)
    await makeRequest('GET + Range bytes=0-0 + correct UA', {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Range': 'bytes=0-0',
    });

    console.log('\nDone.');
}

run();
