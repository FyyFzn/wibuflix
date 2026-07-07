import { extractEpNumStrict, extractEpNum, adjustTitleEpisodeNumber } from './src/utils/stringUtils.js';

console.log("=== Testing extractEpNumStrict with Double-Digit and Delimited Episodes ===");

const testCases = [
    { input: "Episode 10", expected: 10 },
    { input: "episode-10", expected: 10 },
    { input: "episode_10", expected: 10 },
    { input: "episode-010", expected: 10 },
    { input: "oshi-no-ko-s2-episode-10-sub-indo", expected: 10 },
    { input: "oshi-no-ko-s2-ep-10-sub-indo", expected: 10 },
    { input: "Otakudesu_Baki--10_", expected: 10 },
    { input: "Baki - 10 -", expected: 10 },
    { input: "Baki Hanma Season 2 Episode 10", expected: 10 },
    { input: "Baki Hanma Season 2 - 10", expected: 10 },
    { input: "Episode 10 - Sub Indo", expected: 10 },
    { input: "nonton-anime-episode-10-sub-indo", expected: 10 },
    { input: "86 (Eighty Six) Episode 11", expected: 11 },
    { input: "Mob Psycho 100 Episode 12", expected: 12 }
];

let passed = 0;
for (const tc of testCases) {
    const result = extractEpNumStrict(tc.input);
    const success = result === tc.expected;
    if (success) passed++;
    console.log(`[${success ? 'PASS' : 'FAIL'}] Input: "${tc.input}" | Expected: ${tc.expected} | Got: ${result}`);
}

console.log(`\nResult: ${passed}/${testCases.length} passed.`);

console.log("\n=== Testing adjustTitleEpisodeNumber ===");
console.log("Oshi no Ko Season 2 Episode 10 (+1) ->", adjustTitleEpisodeNumber("Oshi no Ko Season 2 Episode 10", 1));
console.log("86 (Eighty Six) Episode 10 (-1) ->", adjustTitleEpisodeNumber("86 (Eighty Six) Episode 10", -1));
