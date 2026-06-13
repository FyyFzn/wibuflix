import mongoose from 'mongoose';

const animeSchema = new mongoose.Schema({
    title: { 
        type: String, 
        required: true,
        index: true 
    },
    aliases: {
        type: [String],
        default: [],
        index: true
    },
    image: { 
        type: String, 
        default: '' 
    },
    type: { 
        type: String, 
        default: 'TV' 
    },
    score: { 
        type: String, 
        default: '-' 
    },
    status: { 
        type: String, 
        default: 'Completed' 
    },
    sources: {
        samehadaku: {
            url: { type: String, default: null },
            id: { type: String, default: null }
        },
        otakudesu: {
            url: { type: String, default: null },
            id: { type: String, default: null }
        }
    },
    tmdbEnriched: {
        type: Boolean,
        default: false
    },
    lastUpdated: {
        type: Date,
        default: Date.now
    }
}, { timestamps: true });

// Buat Text Index untuk mempercepat fitur pencarian (search bar)
animeSchema.index({ title: 'text', aliases: 'text' });

const Anime = mongoose.model('Anime', animeSchema);

export default Anime;
