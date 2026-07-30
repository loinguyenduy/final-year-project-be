import { cloudinary } from '../config/cloudinary.config.js';

const uploadCloudinaryImageBuffer = ({
  buffer,
  folder,
  publicId,
  deliveryType = 'upload'
}) => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream({
      resource_type: 'image',
      folder,
      public_id: publicId,
      type: deliveryType,
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

const destroyCloudinaryImage = async (publicId, deliveryType = 'upload') => {
  if (!publicId) return { result: 'not_found' };
  return cloudinary.uploader.destroy(publicId, {
    resource_type: 'image',
    type: deliveryType,
    invalidate: true
  });
};

const createSignedCloudinaryImageUrl = ({ publicId, format, expiresAt }) => {
  return cloudinary.utils.private_download_url(publicId, format, {
    type: 'authenticated',
    attachment: false,
    expires_at: Math.floor(expiresAt.getTime() / 1000),
    secure: true
  });
};

export {
  createSignedCloudinaryImageUrl,
  destroyCloudinaryImage,
  uploadCloudinaryImageBuffer
};
