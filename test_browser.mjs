/**
 * Tes diagnostik Puppeteer — TANPA --single-process
 */
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

async function runTest() {
    console.log('=== TES DIAGNOSTIK PUPPETEER (TANPA --single-process) ===\n');
    console.log(`Node.js: ${process.version}`);
    console.log(`Memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB RSS\n`);

    // ── TES 1: Launch browser TANPA --single-process ──
    console.log('[Tes 1] Launching browser (tanpa --single-process)...');
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            protocolTimeout: 120000,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        });
        const version = await browser.version();
        console.log(`[Tes 1] ✅ Browser berhasil dibuka! Versi: ${version}`);
        console.log(`[Tes 1] Memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB RSS\n`);
        
        browser.on('disconnected', () => {
            console.error('[FATAL] ⚠️ BROWSER MATI TIBA-TIBA!');
        });
    } catch (err) {
        console.error(`[Tes 1] ❌ GAGAL LAUNCH: ${err.message}`);
        process.exit(1);
    }

    // ── TES 2: Buka halaman biasa ──
    console.log('[Tes 2] Membuka halaman biasa (example.com)...');
    try {
        const ctx = await browser.createBrowserContext();
        const page = await ctx.newPage();
        await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
        const title = await page.title();
        console.log(`[Tes 2] ✅ Berhasil! Title: "${title}"`);
        await page.close();
        await ctx.close();
        console.log(`[Tes 2] Memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB RSS\n`);
    } catch (err) {
        console.error(`[Tes 2] ❌ GAGAL: ${err.message}\n`);
    }

    // ── TES 3: Cek browser masih hidup ──
    console.log('[Tes 3] Mengecek apakah browser masih hidup...');
    try {
        const v = await browser.version();
        console.log(`[Tes 3] ✅ Browser masih hidup! Versi: ${v}\n`);
    } catch (err) {
        console.error(`[Tes 3] ❌ BROWSER SUDAH MATI: ${err.message}\n`);
        process.exit(1);
    }

    // ── TES 4: Buka Samehadaku ──
    console.log('[Tes 4] Membuka Samehadaku (CF protected)...');
    try {
        const ctx2 = await browser.createBrowserContext();
        const page2 = await ctx2.newPage();
        await page2.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36');
        await page2.setRequestInterception(true);
        page2.on('request', req => {
            const type = req.resourceType();
            if (['font', 'image', 'stylesheet', 'media'].includes(type)) return req.abort().catch(() => {});
            req.continue().catch(() => {});
        });
        
        await page2.goto('https://v2.samehadaku.how/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        let elapsed = 0;
        while (elapsed < 15000) {
            const t = await page2.title().catch(() => '');
            if (!t.toLowerCase().includes('just a moment')) {
                console.log(`[Tes 4] ✅ CF bypass berhasil! Title: "${t}"`);
                break;
            }
            await new Promise(r => setTimeout(r, 500));
            elapsed += 500;
        }
        
        const html = await page2.content();
        console.log(`[Tes 4] HTML length: ${html.length} chars`);
        console.log(`[Tes 4] Memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB RSS\n`);
        
        await page2.close();
        await ctx2.close();
    } catch (err) {
        console.error(`[Tes 4] ❌ GAGAL: ${err.message}\n`);
    }

    // ── TES 5: Re-launch ──
    console.log('[Tes 5] Menutup dan meluncurkan browser baru...');
    try {
        await browser.close();
        const browser2 = await puppeteer.launch({
            headless: true,
            protocolTimeout: 120000,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        });
        const v2 = await browser2.version();
        console.log(`[Tes 5] ✅ Re-launch berhasil! Versi: ${v2}`);
        console.log(`[Tes 5] Memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB RSS\n`);
        await browser2.close();
    } catch (err) {
        console.error(`[Tes 5] ❌ GAGAL: ${err.message}\n`);
    }

    console.log('=== TES SELESAI ===');
    process.exit(0);
}

runTest().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
