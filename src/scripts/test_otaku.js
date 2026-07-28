import axios from 'axios';
import * as cheerio from 'cheerio';

axios.get('https://otakudesu.blog/anime-list/')
    .then(res => {
        const $ = cheerio.load(res.data);
        const url = $('.penzbar .jdlbar a').first().attr('href');
        console.log("VALID URL:", url);
    })
    .catch(e => console.error(e.message));
