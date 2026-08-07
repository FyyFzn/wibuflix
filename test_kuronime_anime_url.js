import * as cheerio from 'cheerio';

fetch('https://kuronime.sbs/nonton-otome-kaijuu-carameliser-episode-6/')
    .then(r => r.text())
    .then(html => {
        const $ = cheerio.load(html);
        const url1 = $('.nvs a').attr('href');
        const url2 = $('.thumb a').attr('href');
        const url3 = $('.breadcrumb a').eq(1).attr('href');
        const url4 = $('a[href*="/anime/"]').first().attr('href');
        const url5 = $('.ts-breadcrumb a').eq(1).attr('href');
        console.log({ url1, url2, url3, url4, url5 });
    });
