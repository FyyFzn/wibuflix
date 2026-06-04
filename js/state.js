export const State = {
    currentPage: 1,
    currentSearch: '',
    urlSeriSaatIni: '',
    episodeUrlSaatIni: '',
    gambarSeriSaatIni: '',
    historyPage: 1,
    historyPerPage: 0,
    lastUsedServer: '',
    activeTab: 'anime'
};

export function saveState(layarId) {
    sessionStorage.setItem('appState', JSON.stringify({
        layarId,
        urlSeriSaatIni: State.urlSeriSaatIni,
        gambarSeriSaatIni: State.gambarSeriSaatIni,
        episodeUrlSaatIni: State.episodeUrlSaatIni,
        currentPage: State.currentPage,
        currentSearch: State.currentSearch
    }));
}

export function loadState() {
    const savedStateStr = sessionStorage.getItem('appState');
    if (!savedStateStr) return null;
    try {
        const savedState = JSON.parse(savedStateStr);
        if (savedState.urlSeriSaatIni) State.urlSeriSaatIni = savedState.urlSeriSaatIni;
        if (savedState.gambarSeriSaatIni) State.gambarSeriSaatIni = savedState.gambarSeriSaatIni;
        if (savedState.episodeUrlSaatIni) State.episodeUrlSaatIni = savedState.episodeUrlSaatIni;
        if (savedState.currentPage) State.currentPage = savedState.currentPage;
        if (savedState.currentSearch) State.currentSearch = savedState.currentSearch;
        return savedState;
    } catch (e) {
        return null;
    }
}

// ── Riwayat (localStorage) ──────────────────────────────────────────────
export function getRiwayat() {
    try {
        return JSON.parse(localStorage.getItem('samehadaRiwayat')) || [];
    } catch {
        return [];
    }
}

export function simpanKeRiwayat(judul, url, gambar = '') {
    const judulSeri = judul.replace(/\s+Episode\s+.*/i, '').trim();
    const epMatch = judul.match(/Episode\s+(\d+)/i);
    const nomorEp = epMatch ? epMatch[1] : '';

    let riwayat = getRiwayat();
    riwayat = riwayat.filter(r => r.judulSeri !== judulSeri);
    riwayat.unshift({
        judulSeri,
        nomorEp,
        url,
        gambar,
        waktu: new Date().getTime()
    });

    if (riwayat.length > 50) riwayat = riwayat.slice(0, 50);
    localStorage.setItem('samehadaRiwayat', JSON.stringify(riwayat));
}
