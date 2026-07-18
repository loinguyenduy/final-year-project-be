import { cloudinary } from '../../../core/config/cloudinary.config.js';

const JOB_IMAGE_FOLDER_PREFIX = 'final_year_project/jobs/';

const extractJobImagePublicId = (url) => {
    if (typeof url !== 'string' || !url.trim()) return null;
    try {
        const parsed = new URL(url);
        const marker = '/upload/';
        const markerIndex = parsed.pathname.indexOf(marker);
        if (markerIndex < 0) return null;
        let publicPath = decodeURIComponent(parsed.pathname.slice(markerIndex + marker.length));
        publicPath = publicPath.replace(/^v\d+\//, '').replace(/\.[^/.]+$/, '');
        return publicPath.startsWith(JOB_IMAGE_FOLDER_PREFIX) ? publicPath : null;
    } catch {
        return null;
    }
};

const destroyPublicIdsBestEffort = async (publicIds, context = {}) => {
    const uniqueIds = [...new Set((publicIds || []).filter(Boolean))];
    await Promise.all(uniqueIds.map(async (publicId) => {
        try {
            await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
        } catch (error) {
            console.error('[matchmaking] Failed to clean up a Job image.', {
                ...context,
                public_id: publicId,
                error: error?.message || 'Unknown error'
            });
        }
    }));
};

const cleanupUploadedJobImages = (files, context = {}) => destroyPublicIdsBestEffort(
    (files || []).map((file) => file?.filename),
    context
);

const cleanupRemovedJobImages = (urls, context = {}) => destroyPublicIdsBestEffort(
    (urls || []).map(extractJobImagePublicId),
    context
);

export {
    cleanupRemovedJobImages,
    cleanupUploadedJobImages,
    extractJobImagePublicId
};
