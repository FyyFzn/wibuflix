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
    normalizedTitle: {
        type: String,
        index: true,
        default: ''
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
        },
        neosatsu: {
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

// Dihapus text index lama karena akan diganti dengan Atlas Search

const Anime = mongoose.model('Anime', animeSchema);

export default Anime;
