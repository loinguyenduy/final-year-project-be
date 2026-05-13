import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import multer from 'multer';
import dotenv from 'dotenv';

dotenv.config();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Config Cloudinary Storage for KYC
const kycStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    const userId = req.user.id; 
    return {
      folder: `final_year_project/kyc/${userId}`, // Create a folder for each user 
      allowed_formats: ['jpg', 'jpeg', 'png'],
      // File name format: fieldname_timestamp (e.g., cccd_front_1690000000000.jpg)
      public_id: `${file.fieldname}_${Date.now()}`, 
    };
  },
});

// Middleware to handle KYC document uploads
const uploadKycMiddleware = multer({ 
  storage: kycStorage,
  limits: { fileSize: 5 * 1024 * 1024 } 
}).fields([
  { name: 'cccd_front', maxCount: 1 },
  { name: 'cccd_back', maxCount: 1 },
  { name: 'portrait', maxCount: 1 }
]);

export { cloudinary, uploadKycMiddleware };