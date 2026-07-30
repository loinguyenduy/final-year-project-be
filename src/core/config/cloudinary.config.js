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

const kycUploadFields = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 5
  },
  fileFilter: (_req, file, callback) => {
    if (!['image/jpeg', 'image/png'].includes(file.mimetype)) {
      const error = new Error('Only JPEG and PNG images are supported.');
      error.code = 'INVALID_IMAGE_TYPE';
      return callback(error);
    }
    return callback(null, true);
  }
}).fields([
  { name: 'cccd_front', maxCount: 1 },
  { name: 'cccd_back', maxCount: 1 },
  { name: 'portrait', maxCount: 1 },
  { name: 'cv', maxCount: 1 },       
  { name: 'certificate', maxCount: 1 }
]);

const uploadKycMiddleware = (req, res, next) => {
  kycUploadFields(req, res, (error) => {
    if (!error) return next();
    const isSizeError = error.code === 'LIMIT_FILE_SIZE';
    const isCountError = ['LIMIT_FILE_COUNT', 'LIMIT_UNEXPECTED_FILE'].includes(error.code);
    return res.status(400).json({
      EM: isSizeError
        ? 'Each KYC document must be 5 MB or smaller.'
        : isCountError
          ? 'The KYC document set contains an unexpected or duplicate file.'
          : error.message || 'Invalid KYC document upload.',
      EC: 400,
      code: isSizeError ? 'KYC_FILE_TOO_LARGE' : 'VALIDATION_ERROR',
      DT: ''
    });
  });
};

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

const evidenceMaxSizeBytes = Math.floor(
  readPositiveNumber(
    process.env.JOB_EVIDENCE_MAX_SIZE_MB,
    readPositiveNumber(process.env.BEFORE_EVIDENCE_MAX_SIZE_MB, 5)
  ) * 1024 * 1024
);

// BEFORE evidence is buffered so the service can calculate SHA-256 before
// uploading. Authentication still runs before this middleware at the route.
const uploadEvidenceMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: evidenceMaxSizeBytes,
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

const uploadBeforeEvidenceMiddleware = uploadEvidenceMiddleware;

export {
  cloudinary,
  uploadEvidenceMiddleware,
  uploadBeforeEvidenceMiddleware,
  uploadKycMiddleware,
  uploadJobImagesMiddleware
};
