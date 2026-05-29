import { saveState } from './state.js';

// ── Elemen Loading ──────────────────────────────────────
export const loading = document.getElementById('loading');
export const loadingText = document.getElementById('loadingText');

// ── Layar ───────────────────────────────────────────────
export const layarKatalog = document.getElementById('layarKatalog');
export const layarDaftarEpisode = document.getElementById('layarDaftarEpisode');
export const layarPlayer = document.getElementById('layarPlayer');
export const layarHistory = document.getElementById('layarHistory');

// ── Katalog ────────────────────────────────────
export const katalogGrid = document.getElementById('katalogGrid');
export const inputSearch = document.getElementById('inputSearch');
export const btnSearch = document.getElementById('btnSearch');
export const btnPagePrev = document.getElementById('btnPagePrev');
export const btnPageNext = document.getElementById('btnPageNext');
export const pageInfo = document.getElementById('pageInfo');

// ── Daftar Episode ─────────────────────────────
export const judulSeriAnime = document.getElementById('judulSeriAnime');
export const judulSeriAnimeFallback = document.getElementById('judulSeriAnimeFallback');
export const epsListContainer = document.getElementById('epsListContainer');
export const btnKembaliKatalog = document.getElementById('btnKembaliKatalog');

// ── Player ─────────────────────────────────────
export const embedPlayer = document.getElementById('embedPlayer');
export const playerOverlay = document.getElementById('playerOverlay');
export const judulEpisode = document.getElementById('judulEpisode');
export const serverListContainer = document.getElementById('serverList');
export const btnPrev = document.getElementById('btnPrev');
export const btnNext = document.getElementById('btnNext');
export const btnKembaliEps = document.getElementById('btnKembaliEps');

// ── Topbar & History ────────────────────────────────────
export const logoTitle = document.getElementById('logoTitle');
export const historyTopbar = document.getElementById('historyTopbar');
export const historyIconBtn = document.getElementById('historyIconBtn');
export const btnKembaliDariHistory = document.getElementById('btnKembaliDariHistory');
export const btnHistoryPrev = document.getElementById('btnHistoryPrev');
export const btnHistoryNext = document.getElementById('btnHistoryNext');
export const historyPageInfo = document.getElementById('historyPageInfo');
export const historyPaginationArea = document.getElementById('historyPaginationArea');

export function tampilkan(layar) {
    [layarKatalog, layarDaftarEpisode, layarPlayer, layarHistory].forEach(l => l.classList.add('hidden'));
    loading.classList.add('hidden');
    layar.classList.remove('hidden');

    saveState(layar.id);
}

export function setLoading(teks = 'Memuat data...') {
    [layarKatalog, layarDaftarEpisode, layarPlayer, layarHistory].forEach(l => l.classList.add('hidden'));
    loadingText.textContent = teks;
    loading.classList.remove('hidden');
}

export function formatWaktuYangLalu(timestamp) {
    const detik = Math.floor((new Date().getTime() - timestamp) / 1000);
    if (detik < 60) return 'Baru saja';
    const menit = Math.floor(detik / 60);
    if (menit < 60) return `${menit} mnt yang lalu`;
    const jam = Math.floor(menit / 60);
    if (jam < 24) return `${jam} jam yang lalu`;
    const hari = Math.floor(jam / 24);
    if (hari < 7) return `${hari} hari yang lalu`;
    return new Date(timestamp).toLocaleDateString('id-ID');
}
