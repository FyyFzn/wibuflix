import * as cheerio from 'cheerio';

fetch('https://kuronime.sbs/anime/otome-kaijuu-carameliser/')
    .then(r => r.text())
    .then(html => {
        const $ = cheerio.load(html);
        const eps = [];
        $('div.bixbox.bxcl ul li, .eplister ul li, ul.eplister li, .lstepsiode ul li, #episode_list li, .episodelist ul li, .listeps ul li, .lastep li, div.bxcl ul li, div.epcurlast ul li, div.bixbox ul li, div.bxcl li, div[class*="eplister"] li, ul[class*="eplister"] li, div[class*="list"] ul li, ul[class*="list"] li').each((_, el) => {
            const a = $(el).find('a').first();
            const href = a.attr('href');
            if (href && href.includes('/anime/')) {
                eps.push(href);
            }
        });
        console.log("Anime detail URLs caught by episode selector:", eps.length);
        console.log(eps.slice(0, 5));
    });
