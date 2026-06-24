import { extractSlugs } from './src/routes/extract.js';

const episodeUrl = "https://samehadaku.email/naruto-episode-1";
const seriesUrl = "https://samehadaku.email/anime/naruto";
const seriesTitle = "Naruto Shippuden";
const uniqueId = "mal-12345";

console.log("=== With uniqueId (New Flow) ===");
const res1 = extractSlugs(episodeUrl, seriesUrl, seriesTitle, uniqueId);
console.log(res1);

console.log("\n=== Without uniqueId (Old Flow / The Bug) ===");
const res2 = extractSlugs(episodeUrl, null, seriesTitle, null);
console.log(res2);
