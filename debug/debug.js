const puppeteer = require('puppeteer');

(async () => {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto('https://v2.samehadaku.how/', { waitUntil: 'domcontentloaded' });
    
    const html = await page.evaluate(() => {
        return document.querySelector('.post-show ul li') ? document.querySelector('.post-show ul li').innerHTML : 'NO .post-show ul li';
    });
    console.log('post-show ul li HTML:', html);
    
    await browser.close();
})();