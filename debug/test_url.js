const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

(async () => {
    const browser = await puppeteer.launch({headless: true, args: ['--no-sandbox']});
    const page = await browser.newPage();
    await page.goto('https://v2.samehadaku.how/daftar-anime-2/page/4/', {waitUntil: 'domcontentloaded'});
    // Let's just grab elements that might be the anime list
    const items = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.animepost')).slice(0, 2).map(el => {
            const titleNode = el.querySelector('.title, .tt h2, .entry-title');
            const linkNode = el.querySelector('a');
            const imgNode = el.querySelector('img');
            return {
                title: titleNode ? titleNode.innerText : null,
                link: linkNode ? linkNode.href : null,
                img: imgNode ? imgNode.src : null,
                hasTitle: !!titleNode,
                hasLink: !!linkNode,
                hasImg: !!imgNode
            };
        });
    });
    console.log(items);
    await browser.close();
})();
