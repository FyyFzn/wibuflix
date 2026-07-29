import { normalizeTitleForMatch, extractEpNumStrict } from '../utils/stringUtils.js';
import { canonicalTitleMap } from './canonicalService.js';

export function extractSlugs(episodeUrl, seriesUrl, seriesTitle, uniqueId, episodeTitle = '') {
    let episodeSlug = '';
    let seriesSlug = '';
    let urlSlug = '';

    if (episodeUrl.includes('___neosatsu_ep___')) {
        const parts = episodeUrl.split('___neosatsu_ep___');
        const seriesPart = parts[0];
        episodeSlug = parts[1];

        if (seriesPart.startsWith('neosatsu-merge:') || seriesPart.startsWith('neosatsu-label:')) {
            const dataStr = seriesPart.split(':').slice(1).join(':'); 
            const titlePart = dataStr.split('||')[0].trim(); 
            seriesSlug = titlePart
                .toLowerCase()
                .replace(/[^a-z0-9\s-]/g, '')
                .trim()
                .replace(/\s+/g, '-')
                || 'neosatsu_series';
        } else {
            let cleanPart = seriesPart.replace(/\/$/, '');
            seriesSlug = cleanPart.split('/').pop() || 'neosatsu_series';
            seriesSlug = seriesSlug.replace(/\.html/g, '');
        }
    } else {
        let realEpUrl = episodeUrl;
        if (episodeUrl.includes('?url=')) {
            realEpUrl = decodeURIComponent(episodeUrl.split('?url=')[1]);
        }

        // Pisahkan query string sebelum mengekstrak slug path
        // Ini penting untuk URL virtual seperti Nimegami: https://nimegami.id/black-lagoon-s2/?ep=1
        // tanpa ini, split('/').pop() akan menghasilkan "?ep=1" bukan "black-lagoon-s2"
        let urlPathOnly = realEpUrl;
        let urlQueryStr = '';
        const qIdx = realEpUrl.indexOf('?');
        if (qIdx !== -1) {
            urlPathOnly = realEpUrl.substring(0, qIdx);
            urlQueryStr = realEpUrl.substring(qIdx);
        }

        const cleanUrl = urlPathOnly.replace(/\/$/, '');
        episodeSlug = cleanUrl.split('/').pop() || 'uncategorized_ep';

        // Nimegami menggunakan Virtual Episode Routing (?ep=N) bukan path episode terpisah.
        // Normalisasi episodeSlug agar mengandung nomor episode dari query string.
        if (realEpUrl.includes('nimegami') && urlQueryStr) {
            const epMatch = urlQueryStr.match(/[?&]ep=(\d+)/);
            if (epMatch) {
                // Format: {anime-slug}-episode-{N} agar konsisten dengan provider lain
                episodeSlug = `${episodeSlug}-episode-${epMatch[1]}`;
            }
        }

        // Kuronime menggunakan prefix "nonton-" di URL episode (misal: /nonton-baki-dou-episode-1/)
        // Hapus prefix ini dari episodeSlug agar nama folder di Azure konsisten dengan provider lain
        if (realEpUrl.includes('kuronime.sbs') && episodeSlug.startsWith('nonton-')) {
            episodeSlug = episodeSlug.replace(/^nonton-/, '');
        }

        if (seriesUrl) {
            let realSeriesUrl = seriesUrl;
            if (seriesUrl.includes('?url=')) {
                realSeriesUrl = decodeURIComponent(seriesUrl.split('?url=')[1]);
            }
            seriesSlug = realSeriesUrl.replace(/\/$/, '').split('/').pop() || 'uncategorized';
        } else {
            seriesSlug = episodeSlug.replace(/-episode-\d+.*$/i, '').replace(/-dan-sub-indo.*$/i, '');
        }
    }
    
    urlSlug = seriesSlug || 'uncategorized';

    const rawEpSlug = episodeSlug;
    const episodeSlugsToCheck = [];
    let unifiedEpSlug = null;
    
    let epNum = null;
    if (episodeTitle) epNum = extractEpNumStrict(episodeTitle);
    if (epNum === null) epNum = extractEpNumStrict(rawEpSlug.replace(/-/g, ' '));
    
    let specialEpSlug = null;
    const specialMatch = (episodeTitle || '').match(/(ova|oad|special|sp|movie|film)[\s-_]*(\d+(?:\.\d+)?)/i);
    if (specialMatch) {
        let type = specialMatch[1].toLowerCase();
        if (type === 'sp') type = 'special';
        if (type === 'film') type = 'movie';
        specialEpSlug = `${type}-${parseFloat(specialMatch[2])}`;
    } else {
        const slugSpecialMatch = rawEpSlug.replace(/-/g, ' ').match(/(ova|oad|special|sp|movie|film)[\s-_]*(\d+(?:\.\d+)?)/i);
        if (slugSpecialMatch) {
            let type = slugSpecialMatch[1].toLowerCase();
            if (type === 'sp') type = 'special';
            if (type === 'film') type = 'movie';
            specialEpSlug = `${type}-${parseFloat(slugSpecialMatch[2])}`;
        }
    }

    if (epNum !== null) {
        unifiedEpSlug = `episode-${epNum}`;
    } else if (specialEpSlug !== null) {
        unifiedEpSlug = specialEpSlug;
    }
    
    if (unifiedEpSlug !== null) {
        if (!episodeSlugsToCheck.includes(unifiedEpSlug)) {
            episodeSlugsToCheck.push(unifiedEpSlug);
        }
        episodeSlug = unifiedEpSlug; // use this as the primary for new uploads
    }
    
    if (rawEpSlug && !episodeSlugsToCheck.includes(rawEpSlug)) {
        episodeSlugsToCheck.push(rawEpSlug);
    }
    
    if (episodeSlugsToCheck.length === 0) {
        episodeSlugsToCheck.push('uncategorized_ep');
        episodeSlug = 'uncategorized_ep';
    }

    const slugsToCheck = [];
    let primarySlug = '';

    if (uniqueId && uniqueId.toString().trim() !== '') {
        const rawUniqueId = uniqueId.toString().trim();
        let titleSlug = '';
        
        // Cek apakah kita punya judul kanonikal dari database di cache
        if (canonicalTitleMap.has(rawUniqueId)) {
            titleSlug = canonicalTitleMap.get(rawUniqueId).replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
        } else if (seriesTitle && seriesTitle.trim().length > 0) {
            const cleanTitle = normalizeTitleForMatch(seriesTitle);
            if (cleanTitle) titleSlug = cleanTitle.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
        }

        if (titleSlug) {
            // Gabungkan ID unik dengan judul agar nama folder di Azure Storage mudah dibaca
            primarySlug = `${rawUniqueId}_${titleSlug}`;
            slugsToCheck.push(primarySlug);
            
            // Tambahkan variasi spasi & underscore ke slugsToCheck agar folder lama (seperti mal-49784_mairimashita iruma kun s3) tetap terdeteksi!
            const spaceSlug = `${rawUniqueId}_${titleSlug.replace(/-/g, ' ')}`;
            if (!slugsToCheck.includes(spaceSlug)) slugsToCheck.push(spaceSlug);
            const underSlug = `${rawUniqueId}_${titleSlug.replace(/-/g, '_')}`;
            if (!slugsToCheck.includes(underSlug)) slugsToCheck.push(underSlug);
            
            // Tambahkan juga kombinasi dengan seriesTitle lokal jika berbeda (untuk kompatibilitas upload sebelumnya)
            if (seriesTitle && seriesTitle.trim().length > 0) {
                const cleanLocalTitle = normalizeTitleForMatch(seriesTitle);
                if (cleanLocalTitle) {
                    const localTitleSlug = cleanLocalTitle.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
                    const localPrimary = `${rawUniqueId}_${localTitleSlug}`;
                    if (!slugsToCheck.includes(localPrimary)) slugsToCheck.push(localPrimary);
                    const localSpace = `${rawUniqueId}_${cleanLocalTitle}`;
                    if (!slugsToCheck.includes(localSpace)) slugsToCheck.push(localSpace);
                    if (!slugsToCheck.includes(localTitleSlug)) slugsToCheck.push(localTitleSlug);
                }
            }
            
            slugsToCheck.push(rawUniqueId); // Fallback ke mal id murni untuk kompatibilitas data lama
            if (!slugsToCheck.includes(titleSlug)) slugsToCheck.push(titleSlug);
        } else {
            primarySlug = rawUniqueId;
            slugsToCheck.push(primarySlug);
        }
    } else if (seriesTitle && seriesTitle.trim().length > 0) {
        const cleanTitle = normalizeTitleForMatch(seriesTitle);
        if (cleanTitle) {
            const titleSlug = cleanTitle.replace(/\s+/g, '-');
            if (titleSlug && !slugsToCheck.includes(titleSlug)) {
                slugsToCheck.push(titleSlug);
            }
        }
    }
    
    if (urlSlug && !slugsToCheck.includes(urlSlug)) {
        slugsToCheck.push(urlSlug);
    }
    
    if (!primarySlug && slugsToCheck.length > 0) {
        primarySlug = slugsToCheck[0];
    }
    if (!primarySlug) primarySlug = 'uncategorized';

    return { seriesSlug: primarySlug, episodeSlug, oldSeriesSlug: urlSlug, slugsToCheck, episodeSlugsToCheck };
}
