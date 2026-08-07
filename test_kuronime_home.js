import * as cheerio from 'cheerio';

fetch('https://kuronime.sbs/')
    .then(r => r.text())
    .then(html => {
        const $ = cheerio.load(html);
        const updates = [];
        $('.bixbox').first().find('article.bsu').each((_, el) => {
            const links = [];
            $(el).find('a').each((_, a) => {
                links.push($(a).attr('href'));
            });
            updates.push({ links });
        });
        console.log(JSON.stringify(updates.slice(0, 3), null, 2));
    });
