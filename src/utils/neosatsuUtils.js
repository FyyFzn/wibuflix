/**
 * Menyaring daftar tokusatsu berdasarkan tipe filter Neosatsu.
 * @param {Array} list - Daftar item tokusatsu
 * @param {string} typeFilter - Kategori filter (e.g. 'kamen rider', 'super sentai', dll)
 * @returns {Array} Daftar item tersaring
 */
export function filterByTokuType(list, typeFilter) {
    if (!typeFilter) return list;
    const fLow = typeFilter.toLowerCase();
    
    if (fLow === 'kamen rider') {
        return list.filter(item => item.title.toLowerCase().includes('kamen rider'));
    } else if (fLow === 'super sentai') {
        return list.filter(item => {
            const t = item.title.toLowerCase();
            return t.includes('sentai') && !t.includes('power ranger');
        });
    } else if (fLow === 'power rangers') {
        return list.filter(item => item.title.toLowerCase().includes('power ranger'));
    } else if (fLow === 'ultraman') {
        return list.filter(item => item.title.toLowerCase().includes('ultraman'));
    } else if (fLow === 'lainnya') {
        return list.filter(item => {
            const t = item.title.toLowerCase();
            return !t.includes('kamen rider') && !t.includes('sentai') && !t.includes('power ranger') && !t.includes('ultraman');
        });
    } else {
        return list.filter(item => item.tipe.toLowerCase() === fLow);
    }
}

/**
 * Mendekripsi string enkripsi Neosatsu menjadi URL asli.
 * @param {string} encryptedId - ID terenkripsi dari Neosatsu
 * @returns {string|null} URL asli atau null jika gagal
 */
export function decryptNeosatsuLink(encryptedId) {
    if (!encryptedId || encryptedId.length <= 13) return null;
    try {
        const b64 = encryptedId.substring(10, encryptedId.length - 3);
        const decryptedPath = Buffer.from(b64, 'base64').toString('utf8');
        return `https:/${decryptedPath}`;
    } catch (e) {
        return null;
    }
}

/**
 * Menormalisasi URL Google Drive menjadi URL preview embed.
 * @param {string} url - URL Google Drive
 * @returns {string} URL preview yang siap digunakan di iframe
 */
export function normalizeGDriveUrl(url) {
    if (!url || !url.includes('drive.google.com')) return url;
    let finalUrl = url.replace(/\/view(\?.*)?$/, '/preview');
    try {
        const urlObj = new URL(finalUrl);
        if (urlObj.pathname === '/open' || urlObj.pathname === '/uc') {
            const id = urlObj.searchParams.get('id');
            if (id) finalUrl = `https://drive.google.com/file/d/${id}/preview`;
        }
    } catch (e) { }
    return finalUrl;
}
