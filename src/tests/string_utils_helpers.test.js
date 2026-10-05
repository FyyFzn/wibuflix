/**
 * Regression tests untuk helper normalisasi judul.
 *
 * Kedua helper ini dipakai SEMUA provider (oploverz, kuronime, nanime,
 * otakudesu, dll), jadi perubahan di sini berdampak ke seluruh katalog.
 * Test ini mengunci perilaku tersebut agar refactor berikutnya tidak
 * merusak provider lain secara diam-diam.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    cleanSeriesTitle,
    formatEpisodeTitle,
    extractEpNum,
    extractEpNumStrict
} from '../utils/stringUtils.js';

// ─────────────────────────────────────────────────────────────
// cleanSeriesTitle
// ─────────────────────────────────────────────────────────────

test('cleanSeriesTitle: menghapus nama situs yang dikenal', () => {
    // Oploverz ditambahkan saat migrasi ke oploverz.site.
    assert.equal(cleanSeriesTitle('Naruto | Oploverz'), 'Naruto');
    assert.equal(cleanSeriesTitle('3D Kanojo: Real Girl | Oploverz'), '3D Kanojo: Real Girl');
    assert.equal(cleanSeriesTitle('Akame ga Kill! | Oploverz'), 'Akame ga Kill!');

    // Nama situs lama harus tetap terpakai (regresi).
    assert.equal(cleanSeriesTitle('Naruto | Samehadaku'), 'Naruto');
    assert.equal(cleanSeriesTitle('Bleach | Otakudesu'), 'Bleach');
    assert.equal(cleanSeriesTitle('One Piece | Kuronime'), 'One Piece');
    assert.equal(cleanSeriesTitle('Boruto | Neosatsu'), 'Boruto');
    assert.equal(cleanSeriesTitle('Hyouka | Nimegami'), 'Hyouka');
});

test('cleanSeriesTitle: tidak memotong judul yang mengandung kata mirip', () => {
    // Judul asli yang TIDAK boleh ikut terpotong.
    const safe = [
        'Overtake',
        'Dr. Stone',
        'Steins;Gate',
        'Fate/stay night',
        'Re:Zero',
        '86 Eighty-Six',
        'Attack on Titan',
        'Kaguya-sama: Love is War'
    ];
    for (const t of safe) {
        assert.equal(cleanSeriesTitle(t), t, `judul tidak boleh berubah: ${t}`);
    }
});

test('cleanSeriesTitle: pipe di tengah judul tidak dihapus', () => {
    assert.equal(cleanSeriesTitle('Fate | Stay Night'), 'Fate | Stay Night');
});

test('cleanSeriesTitle: keyword SEO dan metadata episode dibersihkan', () => {
    assert.equal(cleanSeriesTitle('Naruto Sub Indo'), 'Naruto');
    assert.equal(cleanSeriesTitle('Naruto Subtitle Indonesia'), 'Naruto');
    assert.equal(cleanSeriesTitle('Naruto Episode 5'), 'Naruto');
    assert.equal(cleanSeriesTitle('Naruto Batch'), 'Naruto');
    assert.equal(cleanSeriesTitle('Naruto Tamat'), 'Naruto');
});

test('cleanSeriesTitle: input kosong menghasilkan string kosong', () => {
    assert.equal(cleanSeriesTitle(''), '');
    assert.equal(cleanSeriesTitle('   '), '');
    assert.equal(cleanSeriesTitle(null), '');
    assert.equal(cleanSeriesTitle(undefined), '');
});

// ─────────────────────────────────────────────────────────────
// formatEpisodeTitle
// ─────────────────────────────────────────────────────────────

test('formatEpisodeTitle: membuang pemisah di akhir agar nomor tertangkap', () => {
    // Bug oploverz.site: judul berakhir dengan "|" sehingga angka tidak
    // terkunci oleh pola end-anchored dan extractEpNum mengembalikan null.
    assert.equal(formatEpisodeTitle('86 Eighty-Six Part  1 |'), 'Episode 1');
    assert.equal(formatEpisodeTitle('Black Clover Episode 24 |'), 'Episode 24');

    // Pola judul fansub Bergaya "Baki - 01 -"
    assert.equal(formatEpisodeTitle('Baki - 01 -'), 'Episode 01');
});

test('formatEpisodeTitle: pemisah di TENGAH judul tidak boleh dihapus', () => {
    // Regresi: bila helper pemisah hilang, judul ini terpotong jadi "Night".
    assert.equal(formatEpisodeTitle('Fate | Stay Night - 01'), 'Episode 01');
    assert.equal(formatEpisodeTitle('A | B Episode 3'), 'Episode 3');
});

test('formatEpisodeTitle: pola per provider tetap menghasilkan nomor benar', () => {
    const cases = [
        // oploverz
        ['Naruto Episode 5 |', 'Episode 5'],
        ['3D Kanojo: Real Girl Episode 1 |', 'Episode 1'],
        // kuronime / nanime
        ['Episode 12', 'Episode 12'],
        ['Baki 01 (End)', 'Episode 01'],
        ['One Piece Episode 1050', 'Episode 1050'],
        ['Episode 1.5', 'Episode 1.5'],
        ['Bleach - 366', 'Episode 366'],
        // otakudesu
        ['One Piece - 1050', 'Episode 1050'],
        ['Kimetsu no Yaiba - 04', 'Episode 04']
    ];
    for (const [input, expected] of cases) {
        assert.equal(formatEpisodeTitle(input), expected, `gagal untuk: ${input}`);
    }
});

test('formatEpisodeTitle: judul tanpa nomor tetap utuh', () => {
    const keep = [
        'Naruto',
        'Bleach',
        'Attack on Titan',
        'Bleach: Thousand-Year Blood War',
        'Naruto Ending',
        '-',
        '|',
        'Episode'
    ];
    for (const t of keep) {
        assert.equal(formatEpisodeTitle(t), t, `tidak boleh berubah: ${t}`);
    }
});

test('formatEpisodeTitle: tipe khusus tetap dikenali', () => {
    assert.equal(formatEpisodeTitle('Naruto OVA 3'), 'OVA 3');
    assert.equal(formatEpisodeTitle('Naruto SP 1'), 'SP 1');
    assert.equal(formatEpisodeTitle('Naruto Batch'), 'Batch');
});

test('formatEpisodeTitle: input kosong tidak melempar error', () => {
    assert.equal(formatEpisodeTitle(''), 'Episode ?');
    assert.equal(formatEpisodeTitle(null), 'Episode ?');
    assert.equal(formatEpisodeTitle(undefined), 'Episode ?');
});

// ─────────────────────────────────────────────────────────────
// extractEpNum — inilah yang rusak karena pipe
// ─────────────────────────────────────────────────────────────

test('extractEpNum: pipe di akhir masih memblokir nomor (perilaku saat ini)', () => {
    // CATATAN: extractEpNum masih memproses judul mentah. Di episodeService.js
    // extractEpNum dipanggil SEBELUM formatEpisodeTitle, jadi pipe pada judul
    // mentah oploverz.site masih membuat nomor jadi null. Test ini mengunci
    // perilaku itu supaya perubahan di masa depan terlihat jelas.
    assert.equal(extractEpNum('86 Eighty-Six Part 1'), 1);
    assert.equal(extractEpNum('86 Eighty-Six Part 1 |'), null);

    // Yang sudah diperbaiki: kalau judul sudah melewati formatEpisodeTitle,
    // nomornya kembali terdeteksi.
    assert.equal(extractEpNum(formatEpisodeTitle('86 Eighty-Six Part 1 |')), 1);
});

test('extractEpNum: judul OVA/SP tetap dikecualikan', () => {
    assert.equal(extractEpNum('Naruto OVA 3'), null);
    assert.equal(extractEpNum('Naruto SP 1'), null);
    assert.equal(extractEpNum('Naruto Movie'), null);
});