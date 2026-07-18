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
  { name: 'portrait', maxCount: 1 },
  { name: 'cv', maxCount: 1 },       
  { name: 'certificate', maxCount: 1 }
]);

// Config Cloudinary Storage for Job Photos
const jobStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    const userId = req.user.id; 
    return {
      folder: `final_year_project/jobs/${userId}`, // Create a folder for each user's jobs
      allowed_formats: ['jpg', 'jpeg', 'png'],
      // Unique name format for job images
      public_id: `job_${Date.now()}_${Math.round(Math.random() * 1e9)}`, 
    };
  },
});

// Middleware to handle Job photo uploads (max 5 images)
const uploadJobImagesMiddleware = multer({ 
  storage: jobStorage,
  limits: { fileSize: 5 * 1024 * 1024 } 
}).array('images', 5);

const readPositiveNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const beforeEvidenceMaxSizeBytes = Math.floor(
  readPositiveNumber(process.env.BEFORE_EVIDENCE_MAX_SIZE_MB, 5) * 1024 * 1024
);

// BEFORE evidence is buffered so the service can calculate SHA-256 before
// uploading. Authentication still runs before this middleware at the route.
const uploadBeforeEvidenceMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: beforeEvidenceMaxSizeBytes,
    files: 1
  },
  fileFilter: (_req, file, callback) => {
    if (!['image/jpeg', 'image/png'].includes(file.mimetype)) {
      const error = new Error('Only JPEG and PNG images are supported.');
      error.code = 'INVALID_IMAGE_TYPE';
      return callback(error);
    }
    return callback(null, true);
  }
}).single('image');

export {
  cloudinary,
  uploadBeforeEvidenceMiddleware,
  uploadKycMiddleware,
  uploadJobImagesMiddleware
};
