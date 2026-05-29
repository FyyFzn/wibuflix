const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

(async () => {
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    
    let videoUrl = null;
    page.on('request', req => {
        const url = req.url();
        if (url.includes('googlevideo.com') || url.includes('videoplayback')) {
            videoUrl = url;
            req.abort();
            console.log('Intercepted:', url);
        } else {
            req.continue();
        }
    });

    await page.setRequestInterception(true);
    await page.goto('https://www.blogger.com/video.g?token=AD6v5dyiXxYLzVchVU5N8ckG_tYO5xihf--3mrwCHttavRvzlWmNN6NeXPxx0KpIJXeDkISGV32J610hI9FvTFaOU5w974GglXUrozt3wSYVJxlFe-D7BVu60rmQ3NaP4Cm4_Q2uZr4', { waitUntil: 'networkidle2' });

    console.log('Evaluating...');
    await page.evaluate(() => {
        const playBtn = document.querySelector('.ytp-large-play-button, .play-button, button');
        if (playBtn) playBtn.click();
        const v = document.querySelector('video');
        if (v) v.play().catch(e => console.log('play err:', e.message));
    }).catch(e => console.log('Eval error:', e));

    try {
        const viewport = page.viewport() || { width: 800, height: 600 };
        await page.mouse.click(viewport.width / 2, viewport.height / 2);
    } catch (e) {}

    await new Promise(r => setTimeout(r, 4000));
    console.log('Final URL:', videoUrl);
    await browser.close();
})();
