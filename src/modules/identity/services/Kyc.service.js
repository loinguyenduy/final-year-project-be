import crypto from 'crypto';
import db from '../../../core/database/connection.js';
import {
  destroyCloudinaryImage,
  uploadCloudinaryImageBuffer
} from '../../../core/utils/cloudinary.util.js';
import { emitToRole } from '../../../core/realtime/realtime.gateway.js';
import User from '../models/User.model.js';
import KycRequest from '../models/KycRequest.model.js';
import {
  KYC_DOCUMENT_FIELDS,
  KYC_REALTIME_EVENTS,
  KYC_REQUIRED_DOCUMENTS
} from '../constants/kyc.constants.js';

class KycSubmissionError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'KycSubmissionError';
    this.status = status;
    this.code = code;
  }
}

// Hàm check định dạng ảnh
const hasValidImageSignature = (file) => {
  const buffer = file?.buffer;
  if (!Buffer.isBuffer(buffer)) return false;
  if (file.mimetype === 'image/jpeg') {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (file.mimetype === 'image/png') {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return buffer.length >= signature.length && signature.every((byte, index) => buffer[index] === byte);
  }
  return false;
};

// Hàm chuẩn hóa file 
const normalizeFiles = (role, files = {}) => {
  const requiredTypes = KYC_REQUIRED_DOCUMENTS[role];
  if (!requiredTypes) {
    throw new KycSubmissionError('This account role cannot submit KYC documents.', 403, 'KYC_SUBMISSION_ROLE_REQUIRED');
  }

  const allowedFields = Object.entries(KYC_DOCUMENT_FIELDS)
    .filter(([, type]) => requiredTypes.includes(type))
    .map(([field]) => field);
  const submittedFields = Object.keys(files);
  if (submittedFields.some((field) => !allowedFields.includes(field))) {
    throw new KycSubmissionError('The submission contains documents that are not allowed for this account role.', 400, 'VALIDATION_ERROR');
  }

  const normalized = allowedFields.map((field) => {
    const entries = files[field];
    if (!Array.isArray(entries) || entries.length !== 1) {
      throw new KycSubmissionError('All required KYC documents must be provided exactly once.', 400, 'KYC_DOCUMENTS_INCOMPLETE');
    }
    const file = entries[0];
    if (!hasValidImageSignature(file)) {
      throw new KycSubmissionError('A KYC document does not match its declared JPEG or PNG type.', 400, 'KYC_FILE_SIGNATURE_INVALID');
    }
    return { field, documentType: KYC_DOCUMENT_FIELDS[field], file };
  });

  if (normalized.length !== requiredTypes.length) {
    throw new KycSubmissionError('The KYC document set is incomplete.', 400, 'KYC_DOCUMENTS_INCOMPLETE');
  }
  return normalized;
};

// Hàm kiểm tra điều kiện nộp KYC
const assertSubmissionEligibility = (user, expectedRole) => {
  if (!user) throw new KycSubmissionError('User not found.', 404, 'KYC_USER_NOT_FOUND');
  if (!user.is_active) throw new KycSubmissionError('User account is inactive.', 403, 'ACCOUNT_INACTIVE');
  if (user.role !== expectedRole) {
    throw new KycSubmissionError('This KYC flow is not available for the account role.', 403, 'KYC_SUBMISSION_ROLE_REQUIRED');
  }
  if (user.kyc_status === 'PENDING') {
    throw new KycSubmissionError('Your KYC request is already pending review.', 409, 'KYC_REQUEST_ALREADY_PENDING');
  }
  if (user.kyc_status === 'VERIFIED') {
    throw new KycSubmissionError('Your account is already verified.', 409, 'KYC_ALREADY_VERIFIED');
  }
  if (!['UNVERIFIED', 'REJECTED'].includes(user.kyc_status)) {
    throw new KycSubmissionError('Your current KYC state does not allow a new submission.', 409, 'KYC_SUBMISSION_NOT_ALLOWED');
  }
};

// Hàm dọn dẹp các ảnh đã upload nếu có lỗi xảy ra
const cleanupUploadedAssets = async (assets, correlationId) => {
  for (const asset of assets) {
    try {
      await destroyCloudinaryImage(asset.public_id, 'authenticated');
    } catch (cleanupError) {
      console.error('[kyc] Failed to clean up a newly uploaded asset.', {
        correlation_id: correlationId,
        public_id: asset.public_id,
        error: cleanupError.message
      });
    }
  }
};

// Hàm chính để nộp KYC
const submitKycService = async ({ userId, role, files, correlationId }) => {
  const normalizedFiles = normalizeFiles(role, files);
  const submissionId = crypto.randomUUID();
  const folder = `final_year_project/kyc/${userId}/${submissionId}`;
  const uploadedAssets = [];
  let transaction = null;

  try {
    for (const item of normalizedFiles) {
      const result = await uploadCloudinaryImageBuffer({
        buffer: item.file.buffer,
        folder,
        publicId: item.documentType,
        deliveryType: 'authenticated'
      });
      uploadedAssets.push({
        documentType: item.documentType,
        mimeType: item.file.mimetype,
        public_id: result.public_id,
        format: result.format
      });
    }

    transaction = await db.transaction();
    const user = await User.findByPk(userId, {
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    assertSubmissionEligibility(user, role);

    const currentMax = await KycRequest.max('submission_sequence', {
      where: { user_id: userId },
      transaction
    });
    const submissionSequence = (Number(currentMax) || 0) + 1;

    await KycRequest.bulkCreate(uploadedAssets.map((asset) => ({
      user_id: userId,
      submission_id: submissionId,
      submission_sequence: submissionSequence,
      document_type: asset.documentType,
      document_url: null,
      cloudinary_public_id: asset.public_id,
      cloudinary_format: asset.format,
      cloudinary_delivery_type: 'authenticated',
      document_mime_type: asset.mimeType,
      status: 'PENDING'
    })), { transaction });

    await user.update({ kyc_status: 'PENDING' }, { transaction });
    await transaction.commit();

    try {
      // Gửi thông báo thời gian thực đến tất cả các socket của vai trò ADMIN 
      // về việc cập nhật hàng đợi KYC.
      emitToRole('ADMIN', KYC_REALTIME_EVENTS.ADMIN_QUEUE_UPDATED, {
        event_id: crypto.randomUUID(),
        occurred_at: new Date().toISOString(),
        queue: 'KYC'
      });
    } catch (realtimeError) {
      console.error('[kyc] Submission committed but realtime notification failed.', {
        correlation_id: correlationId,
        submission_id: submissionId,
        error: realtimeError.message
      });
    }

    return {
      submission_id: submissionId,
      submission_sequence: submissionSequence,
      status: 'PENDING'
    };
  } catch (error) {
    if (transaction && !transaction.finished) await transaction.rollback();
    await cleanupUploadedAssets(uploadedAssets, correlationId);
    if (error instanceof KycSubmissionError) throw error;
    console.error('[kyc] Submission failed.', {
      correlation_id: correlationId,
      user_id: userId,
      error: error.message
    });
    throw new KycSubmissionError('Unable to submit KYC documents.', 500, 'KYC_SUBMISSION_FAILED');
  }
};

const submitCustomerKycService = (userId, files, correlationId) => submitKycService({
  userId,
  role: 'CUSTOMER',
  files,
  correlationId
});

const submitHandymanKycService = (userId, files, correlationId) => submitKycService({
  userId,
  role: 'HANDYMAN',
  files,
  correlationId
});

export {
  KycSubmissionError,
  submitCustomerKycService,
  submitHandymanKycService
};
