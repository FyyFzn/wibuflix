const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs');

(async () => {
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.goto('https://krakenfiles.com/embed-video/9gpqbM7Jd7', { waitUntil: 'networkidle2' });
    
    const html = await page.content();
    fs.writeFileSync('kraken_dump.html', html);
    
    await browser.close();
})();
