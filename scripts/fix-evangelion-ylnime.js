import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Anime from '../src/models/Anime.js';

dotenv.config();

async function fixEvangelionYlnime() {
    try {
        const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
        if (!uri) throw new Error('MONGODB_URI not found in .env');
        
        await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
        console.log('✓ Connected to MongoDB');
        
        const anime = await Anime.findOne({ malId: 30 });
        if (!anime) {
            console.log('✗ Evangelion not found in database');
            process.exit(1);
        }
        
        console.log(`\n=== ${anime.title} ===`);
        console.log(`Episodes: ${anime.episodesCount}`);
        
        // Count ylnime URLs before cleanup
        let ylnimeCount = 0;
        for (const ep of anime.episodesList) {
            const urls = ep.urls instanceof Map ? Object.fromEntries(ep.urls) : ep.urls;
            if (urls && (urls['1'] || urls.ylnime)) {
                ylnimeCount++;
            }
        }
        
        console.log(`\nBefore: ${ylnimeCount} episodes with malformed ylnime URLs`);
        
        // Remove all ylnime URLs (they use wrong &episode= format instead of &ep=)
        for (const ep of anime.episodesList) {
            const urls = ep.urls instanceof Map ? Object.fromEntries(ep.urls) : { ...ep.urls };
            const hadYlnime = urls['1'] || urls.ylnime;
            delete urls['1'];
            delete urls.ylnime;
            ep.urls = urls;
            
            if (hadYlnime) {
                console.log(`  - Removed ylnime from Episode ${ep.num || '?'}`);
            }
        }
        
        await anime.save();
        
        console.log(`\n✓ Cleaned up ${ylnimeCount} malformed ylnime URLs from Evangelion`);
        console.log('✓ Database updated successfully');
        
        process.exit(0);
    } catch (err) {
        console.error('✗ Error:', err.message);
        process.exit(1);
    }
}

fixEvangelionYlnime();
