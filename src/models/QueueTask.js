import mongoose from 'mongoose';

const QueueTaskSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    episodeUrl: { type: String, required: true },
    seriesUrl: { type: String },
    seriesSlug: { type: String },
    seriesTitle: { type: String },
    episodeTitle: { type: String },
    uniqueId: { type: String },
    status: { 
        type: String, 
        enum: ['PENDING', 'UPLOADING', 'COMPLETED', 'FAILED', 'CANCELLED'],
        default: 'PENDING'
    },
    progress: { type: String, default: '' },
    priority: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

// Update timestamp before saving
QueueTaskSchema.pre('save', function() {
    this.updatedAt = Date.now();
});

export default mongoose.model('QueueTask', QueueTaskSchema);
