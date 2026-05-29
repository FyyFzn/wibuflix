const { getKatalog } = require('./src/scraper/katalog');
const { getBrowser } = require('./src/puppeteer/pool');

(async () => {
    try {
        console.log('Testing getKatalog page 4...');
        const result = await getKatalog(4, '');
        console.log(`Result length: ${result.list.length}`);
        if (result.list.length > 0) {
            console.log(`First item: ${result.list[0].judul}`);
        }
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
})();
