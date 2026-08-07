import * as kuronime from './src/services/scrapers/kuronimeScraper.js';

kuronime.getKuronimeServers('https://kuronime.sbs/nonton-otome-kaijuu-carameliser-episode-6/')
    .then(r => {
        console.log(JSON.stringify(r, null, 2));
        process.exit(0);
    });
