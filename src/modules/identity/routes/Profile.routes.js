import express from 'express';
import {
    handleGetUserProfile,
    handleUpdateHandymanAddress,
    handleUpdateHandymanBio,
    handleGetHandymanServices,
    handleAddHandymanService,
    handleRemoveHandymanService,
    handleGetHandymanServiceAreas,
    handleAddHandymanServiceArea,
    handleRemoveHandymanServiceArea,
    handleUpdateHandymanWorkTimes
} from '../controllers/Profile.controller.js';
import { checkUserJWT, checkUserRole } from '../../../core/middlewares/auth.middleware.js';

const router = express.Router();

router.get('/profile', checkUserJWT, handleGetUserProfile);

// Section 1 — Address
router.put('/profile/handyman/address', checkUserJWT, checkUserRole(['HANDYMAN']), handleUpdateHandymanAddress);

// Section 2 — Bio & Services
router.put('/profile/handyman/bio', checkUserJWT, checkUserRole(['HANDYMAN']), handleUpdateHandymanBio);
router.get('/profile/handyman/services', checkUserJWT, checkUserRole(['HANDYMAN']), handleGetHandymanServices);
router.post('/profile/handyman/services', checkUserJWT, checkUserRole(['HANDYMAN']), handleAddHandymanService);
router.delete('/profile/handyman/services/:service_id', checkUserJWT, checkUserRole(['HANDYMAN']), handleRemoveHandymanService);

// Section 3 — Service Areas
router.get('/profile/handyman/service-areas', checkUserJWT, checkUserRole(['HANDYMAN']), handleGetHandymanServiceAreas);
router.post('/profile/handyman/service-areas', checkUserJWT, checkUserRole(['HANDYMAN']), handleAddHandymanServiceArea);
router.delete('/profile/handyman/service-areas/:area_id', checkUserJWT, checkUserRole(['HANDYMAN']), handleRemoveHandymanServiceArea);

// Section 4 — Work Times
router.put('/profile/handyman/work-times', checkUserJWT, checkUserRole(['HANDYMAN']), handleUpdateHandymanWorkTimes);

export default router;
