import { initPagePool } from '../src/puppeteer/pool.js';
import { getKatalog } from '../src/scraper/katalog.js';

async function main() {
    console.log("Initializing pool...");
    await initPagePool();
    console.log("Searching Samehadaku...");
    
    // We bypass the cache using random query or clean search
    const results = await getKatalog(1, "Dr. Stone", "");
    console.log("Search Results:", JSON.stringify(results, null, 2));
    process.exit(0);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
