const axios = require('axios');

function findBestMatch(results, query) {
    if (!results || results.length === 0) return null;
    const qLower = query.toLowerCase();
    
    for (const anime of results) {
        const tMain = (anime.title || '').toLowerCase();
        const tEng = (anime.title_english || '').toLowerCase();
        const syns = (anime.title_synonyms || []).map(s => s.toLowerCase());
        const allTitles = [tMain, tEng, ...syns];
        if (allTitles.includes(qLower)) return anime;
    }

    const seasonMatch = qLower.match(/season\s*(\d+)/) || qLower.match(/s(\d+)/) || qLower.match(/(\d+)nd season/) || qLower.match(/(\d+)rd season/);
    const targetSeason = seasonMatch ? seasonMatch[1] : null;
    const isPart2 = qLower.includes('part 2') || qLower.includes('cour 2');

    if (!targetSeason && !isPart2) {
        return results[0];
    }

    for (const anime of results) {
        const tMain = (anime.title || '').toLowerCase();
        const tEng = (anime.title_english || '').toLowerCase();
        const syns = (anime.title_synonyms || []).map(s => s.toLowerCase());
        const allTitles = [tMain, tEng, ...syns];
        const fullText = allTitles.join(' ');

        let matchesSeason = true;
        if (targetSeason) {
            matchesSeason = allTitles.some(t => 
                t.match(new RegExp(`season\\s*${targetSeason}`)) || 
                t.match(new RegExp(`${targetSeason}nd season`)) ||
                t.match(new RegExp(`${targetSeason}rd season`)) ||
                t.match(new RegExp(`${targetSeason}th season`)) ||
                (targetSeason === '2' && (t.includes(' ii') || t.match(/\bii\b/))) ||
                (targetSeason === '3' && (t.includes(' iii') || t.match(/\biii\b/))) ||
                (targetSeason === '4' && (t.includes(' iv') || t.match(/\biv\b/))) ||
                t.match(new RegExp(`\\s${targetSeason}$`))
            );
        }

        let matchesPart = true;
        if (isPart2) {
            matchesPart = fullText.includes('part 2') || fullText.includes('cour 2');
        } else {
            matchesPart = !(fullText.includes('part 2') || fullText.includes('cour 2'));
        }

        if (matchesSeason && matchesPart) {
            return anime;
        }
    }

    return results[0];
}

async function testJikan() {
    const queries = ["Mushoku Tensei S2", "Mushoku Tensei Season 2 Part 2", "KonoSuba Season 3", "One Piece"];
    
    for (const query of queries) {
        console.log(`\n\n--- Query: ${query} ---`);
        const url = `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query)}&limit=5&sfw=true`;
        const { data } = await axios.get(url);
        
        const best = findBestMatch(data.data, query);
        console.log("BEST MATCH =>", best ? best.title : "None");
    }
}
testJikan().catch(console.error);
