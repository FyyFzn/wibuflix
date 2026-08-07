import * as kuronime from './src/services/scrapers/kuronimeScraper.js';

kuronime.getKuronimeEpisodes('https://kuronime.sbs/anime/one-piece/')
    .then(r => {
        console.log("Total episodes:", r.daftar_episode.length);
        console.log(JSON.stringify(r.daftar_episode.slice(0, 10), null, 2));
        process.exit(0);
    });
