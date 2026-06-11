import { getBrowser } from '../../puppeteer/pool.js';

export const name = 'blogger';

export function match(url) {
    return url.includes('blogger.com/video') || url.includes('blogger.com/video.g');
}

export async function extract(embedUrl, req) {
    console.log(`[Blogger] Extracting: ${embedUrl}`);
    let page;
    try {
        const browser = await getBrowser();
        page = await browser.newPage();
        if (req) {
            req.on('close', () => {
                if (page && !page.isClosed()) page.close().catch(()=>{});
            });
        }
        await page.setRequestInterception(true);

        let videoUrl = null;

        page.on('request', request => {
            const rt = request.resourceType();
            const url = request.url();
            if (url.includes('googlevideo.com') || url.includes('videoplayback')) {
                videoUrl = url;
                return request.abort();
            }
            if (['image', 'font', 'stylesheet'].includes(rt)) {
                return request.abort();
            }
            request.continue();
        });

        page.on('response', async res => {
            if (videoUrl) return;
            const url = res.url();
            if (url.includes('googlevideo.com') || url.includes('videoplayback')) {
                videoUrl = url;
            }
        });

        const extractPromise = new Promise(resolve => {
            const checkInterval = setInterval(() => {
                if (videoUrl) {
                    clearInterval(checkInterval);
                    return resolve(videoUrl);
                }
            }, 100);
            setTimeout(() => { 
                clearInterval(checkInterval); 
                resolve(null); 
            }, 6000);
        });

        await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 6000 }).catch(() => {});

        if (!videoUrl) {
            await page.evaluate(() => {
                const playBtn = document.querySelector('.ppVepb, .iLXc1d, .ytp-large-play-button, .play-button, button, [role="button"]');
                if (playBtn) playBtn.click();
                const v = document.querySelector('video');
                if (v) v.play().catch(() => {});
            }).catch(() => {});

            try {
                const viewport = page.viewport() || { width: 800, height: 600 };
                await page.mouse.click(viewport.width / 2, viewport.height / 2);
                await new Promise(r => setTimeout(r, 200));
                await page.mouse.click(viewport.width / 2, viewport.height / 2);
            } catch (e) {}
        }

        const finalUrl = await extractPromise;
        if (finalUrl) {
            return { url: finalUrl };
        }
        throw new Error('Gagal mengekstrak video dari Blogger');
    } catch (err) {
        console.error('[Blogger] Error:', err.message);
        return null;
    } finally {
        if (page && !page.isClosed()) await page.close().catch(() => {});
    }
}
