/**
 * KatalogResponseDTO
 * Data Transfer Object untuk menstandarisasi bentuk respons API Katalog
 * agar selalu konsisten dan dapat diprediksi oleh antarmuka frontend (React Native / Web).
 */
export class KatalogResponseDTO {
    constructor(item) {
        let finalUrl = '';
        let finalId = '';

        if (item.sources?.samehadaku?.url) {
            finalUrl = item.sources.samehadaku.url;
            finalId = item.sources.samehadaku.id || '';
        } else if (item.sources?.otakudesu?.url) {
            finalUrl = `/anime/${item.sources.otakudesu.id || ''}`;
            finalId = item.sources.otakudesu.id || '';
        } else if (item.sources?.neosatsu?.url) {
            finalUrl = item.sources.neosatsu.url;
            finalId = ''; // Neosatsu menggunakan endpoint URL langsung
        } else if (item.sources?.kuronime?.url) {
            finalUrl = item.sources.kuronime.url;
            finalId = item.sources.kuronime.id || '';
        }

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
        this.url = finalUrl;
        this.gambar = item.image || '';
        this.gambarScraper = item.image || '';
        this.tipe = displayType;
        this.skor = item.score || '-';
        this.status = item.status || '';
        this.id = finalId;
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
