import { cloudinary } from '../config/cloudinary.config.js';

const uploadCloudinaryImageBuffer = ({ buffer, folder, publicId }) => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream({
      resource_type: 'image',
      folder,
      public_id: publicId,
      overwrite: false,
      unique_filename: false,
      allowed_formats: ['jpg', 'jpeg', 'png']
    }, (error, result) => {
      if (error) return reject(error);
      return resolve(result);
    });

    uploadStream.on('error', reject);
    uploadStream.end(buffer);
  });
};

const destroyCloudinaryImage = async (publicId) => {
  if (!publicId) return { result: 'not_found' };
  return cloudinary.uploader.destroy(publicId, {
    resource_type: 'image',
    invalidate: true
  });
};

export { destroyCloudinaryImage, uploadCloudinaryImageBuffer };
