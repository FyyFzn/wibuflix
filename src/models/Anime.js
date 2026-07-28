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
    isToku: {
        type: Boolean,
        default: false,
        index: true
    },
    score: {
        type: String,
        default: '-'
    },
    status: {
        type: String,
        default: 'Completed'
    },
    isLocked: {
        type: Boolean,
        default: false
    },
    sourceUrls: [{ type: String, default: null }],
    // Metadata Lanjutan dari MAL / TMDB
    synopsis: { type: String, default: null },
    genres: { type: [String], default: [] },
    episodesCount: { type: Number, default: null },
    episodesList: [{
        _id: false,
        judul: { type: String },
        urls: { type: Map, of: String },
        num: { type: Number, default: null }
    }],
    year: { type: Number, default: null },
    malScore: { type: String, default: null },
    malId: { type: Number, index: true, sparse: true },
    tmdbId: { type: Number, index: true, sparse: true },

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
