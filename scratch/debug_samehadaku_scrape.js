import { initPagePool } from '../src/puppeteer/pool.js';
import { fetchWithCF } from '../src/utils/scrapeHelper.js';
import * as cheerio from 'cheerio';

async function main() {
    await initPagePool();
    const url = "https://v2.samehadaku.how/anime/dr-stone-season-3-part-2/";
    const fetchRes = await fetchWithCF(url, { fetchTimeout: 6000 });
    const $ = fetchRes.$;
    
    console.log("HTML Title:", $('title').text());
    
    $('.lstepsiode ul li, .episodelist ul li, .listeps ul li').each((i, el) => {
        if (i < 3) {
            console.log(`\n--- Item ${i} ---`);
            console.log("Raw HTML:", $(el).html());
            let epLink = $(el).find('.epsleft a').first();
            if (!epLink.length) epLink = $(el).find('a').first();
            
            let epDate = $(el).find('.date').first();
            if (!epDate.length) epDate = $(el).find('.epsright').first();
            console.log("epLink text:", epLink.text().trim());
            console.log("epLink href:", epLink.attr('href'));
            console.log("epDate text:", epDate.text().trim());
        }
    });
    process.exit(0);
}

main().catch(console.error);
