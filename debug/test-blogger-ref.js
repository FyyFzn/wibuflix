const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

(async () => {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({
        'Referer': 'https://v2.samehadaku.how/'
    });
    
    await page.goto('https://www.blogger.com/video.g?token=AD6v5dwTGTgJfD-lOE-THF1oTZgPq79CNsb9KDF5jydrZdLtaUjYo6YpNb82jNUyd-hBZGTgPRdAQtBzhzDgmxNG_9H4IG03SQ1CwXXvVJj6mThAUn-_N6XhWrkC1iev_KgrPmWaI-Y', { waitUntil: 'networkidle2' });
    await page.screenshot({ path: 'blogger_test_ref.png' });
    await browser.close();
})();
