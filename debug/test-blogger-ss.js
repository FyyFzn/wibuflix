const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

(async () => {
    console.log('Launching browser...');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--autoplay-policy=no-user-gesture-required']
    });

    const page = await browser.newPage();
    const embedUrl = 'https://www.blogger.com/video.g?token=AD6v5dwTGTgJfD-lOE-THF1oTZgPq79CNsb9KDF5jydrZdLtaUjYo6YpNb82jNUyd-hBZGTgPRdAQtBzhzDgmxNG_9H4IG03SQ1CwXXvVJj6mThAUn-_N6XhWrkC1iev_KgrPmWaI-Y';
    
    console.log('Going to URL...');
    await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    console.log('Taking screenshot...');
    await page.screenshot({ path: 'blogger_test1.png', fullPage: true });

    await page.evaluate(() => {
        const playBtn = document.querySelector('.ytp-large-play-button, .play-button, button');
        if (playBtn) playBtn.click();
        const v = document.querySelector('video');
        if (v) v.play().catch(() => {});
    }).catch(() => {});

    try {
        const viewport = page.viewport() || { width: 800, height: 600 };
        await page.mouse.click(viewport.width / 2, viewport.height / 2);
    } catch (e) {}

    await new Promise(r => setTimeout(r, 2000));

    console.log('Taking second screenshot...');
    await page.screenshot({ path: 'blogger_test2.png', fullPage: true });

    await browser.close();
    console.log('Done.');
})();
