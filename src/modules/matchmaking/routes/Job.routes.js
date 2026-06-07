import express from 'express';
import { handleCreateJob, handleGetServices, handleGetCustomerJobs, handleGetAvailableJobs } from '../controllers/Job.controller.js';
import { checkUserJWT, checkUserRole } from '../../../core/middlewares/auth.middleware.js';
import { uploadJobImagesMiddleware } from '../../../core/config/cloudinary.config.js';

const router = express.Router();

// Get active services list (Public)
router.get('/services', handleGetServices);

// Customer post a job (Auth -> Customer Role -> Upload Images -> Create Job Controller)
router.post('/jobs', checkUserJWT, checkUserRole(['CUSTOMER']), uploadJobImagesMiddleware, handleCreateJob);

// Get list of jobs posted by the logged-in customer
router.get('/jobs', checkUserJWT, checkUserRole(['CUSTOMER']), handleGetCustomerJobs);

// Get available jobs for handyman (Auth -> Handyman Role)
router.get('/jobs/available', checkUserJWT, checkUserRole(['HANDYMAN']), handleGetAvailableJobs);

export default router;
