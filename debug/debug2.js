const puppeteer = require('puppeteer');

(async () => {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto('https://v2.samehadaku.how/page/2/', { waitUntil: 'domcontentloaded' });
    
    const result = await page.evaluate(() => {
        const itemSelector = '.post-show ul li';
        const els = document.querySelectorAll(itemSelector);
        let count = 0;
        let reasons = [];
        
        els.forEach((el, index) => {
            const titleNode = el.querySelector('.title, .tt h2, .entry-title');
            const linkNode = el.querySelector('a');
            const imgNode = el.querySelector('img');
            
            if (index < 2) {
                reasons.push({
                    titleNode: !!titleNode,
                    titleText: titleNode ? titleNode.innerText : null,
                    linkNode: !!linkNode,
                    linkHref: linkNode ? linkNode.href : null,
                    imgNode: !!imgNode,
                    imgSrc: imgNode ? imgNode.src : null,
                    imgDatasetSrc: imgNode ? imgNode.dataset.src : null,
                });
            }
            if (titleNode && linkNode && imgNode) {
                count++;
            }
        });
        
        return { totalFound: els.length, countValid: count, sample: reasons };
    });
    console.log(JSON.stringify(result, null, 2));
    await browser.close();
})();
