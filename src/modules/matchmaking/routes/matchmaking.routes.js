import express from 'express';
import { handleCreateJob, handleGetCustomerJobs } from '../controllers/CustomerJob.controller.js';
import { handleGetAvailableJobs } from '../controllers/HandymanJob.controller.js';
import { handleGetJobDetails, handleGetServices } from '../controllers/Job.controller.js';
import { handleGetProvinces, handleGetWards } from '../controllers/Location.controller.js';
import { checkUserJWT, checkUserRole } from '../../../core/middlewares/auth.middleware.js';
import { uploadJobImagesMiddleware } from '../../../core/config/cloudinary.config.js';

const router = express.Router();

// Public
router.get('/services', handleGetServices); 
router.get('/provinces', handleGetProvinces);
router.get('/wards', handleGetWards);

// CUSTOMER JOB 
router.post('/jobs', checkUserJWT, checkUserRole(['CUSTOMER']), uploadJobImagesMiddleware, handleCreateJob);
router.get('/jobs', checkUserJWT, checkUserRole(['CUSTOMER']), handleGetCustomerJobs);

// HANDYMAN JOB 
router.get('/jobs/available', checkUserJWT, checkUserRole(['HANDYMAN']), handleGetAvailableJobs);

// COMMON JOB
router.get('/jobs/:id', checkUserJWT, handleGetJobDetails);

export default router;