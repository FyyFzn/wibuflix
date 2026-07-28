/**
 * KatalogResponseDTO
 * Data Transfer Object untuk menstandarisasi bentuk respons API Katalog
 * agar selalu konsisten dan dapat diprediksi oleh antarmuka frontend (React Native / Web).
 */
export class KatalogResponseDTO {
    constructor(item = {}) {
        let finalUrl = item.url || '';
        if (!finalUrl && item.sourceUrls && item.sourceUrls.length > 0) {
            finalUrl = item.sourceUrls[0];
        }
        
        let finalId = item.id || (item._id ? item._id.toString() : '');

        let displayType = item.type || '';
        if (item.type === 'Toku' && item.title) {
            const lowerTitle = item.title.toLowerCase();
            if (lowerTitle.includes('kamen rider')) displayType = 'Kamen Rider';
            else if (lowerTitle.includes('ultraman')) displayType = 'Ultraman';
            else if (lowerTitle.includes('sentai')) displayType = 'Super Sentai';
            else if (lowerTitle.includes('power rangers')) displayType = 'Power Rangers';
            else if (lowerTitle.includes('garo')) displayType = 'Garo';
            else if (lowerTitle.includes('metal hero') || lowerTitle.includes('gavan')) displayType = 'Metal Hero';
        }

        this.judul = item.title || '';
        this.url = finalUrl || item.url || '';
        this.gambar = item.image || '';
        this.gambarScraper = item.image || '';
        this.tipe = displayType || 'TV';
        this.skor = item.score || '-';
        this.status = item.status || 'Completed';
        this.id = finalId || item.id || '';
        this.sources = item.sources || {};
    }

    static from(item) {
        return new KatalogResponseDTO(item);
    }

    static fromList(items) {
        if (!Array.isArray(items)) return [];
        return items.map(item => new KatalogResponseDTO(item));
    }
}
