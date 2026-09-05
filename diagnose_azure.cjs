/**
 * Jalankan script ini LANGSUNG di Azure server:
 *   node diagnose_azure.cjs
 * 
 * Ini akan membuktikan apakah 403 karena IP datacenter atau header.
 */
const https = require('https');

const TARGET_URL = 'https://s3.animeverse.id/ngentot/v416XVk2.mp4';

function req(label, headers, method = 'GET') {
    return new Promise((resolve) => {
        const url = new URL(TARGET_URL);
        const r = https.request({
            hostname: url.hostname,
            path: url.pathname,
            method,
            headers,
            timeout: 8000,
        }, (res) => {
            res.resume(); // drain without buffering body
            const cf = res.headers['cf-ray'] || 'none';
            console.log(`[${res.statusCode}] ${label}`);
            console.log(`       CF-Ray: ${cf}  CL: ${res.headers['content-length'] || '?'}`);
            resolve(res.statusCode);
        });
        r.on('timeout', () => { console.log(`[TIMEOUT] ${label}`); r.destroy(); resolve('TIMEOUT'); });
        r.on('error', (e) => { console.log(`[ERROR] ${label}: ${e.message}`); resolve('ERROR'); });
        r.end();
    });
}

async function run() {
    const { execSync } = require('child_process');
    let myIp = 'unknown';
    try { myIp = execSync('curl -s https://api.ipify.org', { timeout: 5000 }).toString().trim(); } catch(e) {}
    
    console.log(`\n=== Azure Server IP: ${myIp} ===`);
    console.log(`Testing: ${TARGET_URL}\n`);

    await req('No headers', {});
    await req('Browser UA + Referer', {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        'Referer': 'https://animeverse.id/'
    });
    await req('Range bytes=0-0 + Browser UA', {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        'Referer': 'https://animeverse.id/',
        'Range': 'bytes=0-0'
    });
    await req('HEAD request', {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    }, 'HEAD');

    console.log('\nJika semua [403] = IP datacenter diblokir (tidak ada fix dari sisi header).');
    console.log('Jika ada yang [200] = Ada header tertentu yang bisa fix masalah ini.\n');
}

run();
