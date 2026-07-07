/**
 * Neosatsu Controller Facade
 * File ini telah di-refactor. Logika scraping web kini berada di src/services/scrapers/neosatsuScraperService.js.
 * Ekspor dipertahankan di sini untuk kompatibilitas mundur (backward compatibility).
 */
export { cache, getNeosatsuCatalog, getNeosatsuEpisodes, getNeosatsuServers } from '../services/scrapers/neosatsuScraperService.js';
