import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import multer from 'multer';
import dotenv from 'dotenv';

dotenv.config();

// 1. Cấu hình thông tin kết nối (Lấy từ file .env giống project cũ)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// 2. Cấu hình kho lưu trữ (Storage) cho luồng KYC
const kycStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    // Lấy user_id từ req.user (Middleware verify token phải chạy trước cái này)
    const userId = req.user.id; 
    
    return {
      folder: `final_year_project/kyc/${userId}`, // Tạo thư mục linh động theo ID user
      allowed_formats: ['jpg', 'jpeg', 'png'],
      // Đặt tên file trên Cloudinary để dễ nhận biết (Ví dụ: CCCD_FRONT_169...jpg)
      public_id: `${file.fieldname}_${Date.now()}`, 
    };
  },
});

// 3. Khởi tạo middleware của Multer
// fields: Chỉnh định rõ tên các trường (fieldname) mà Frontend sẽ gửi lên
const uploadKycMiddleware = multer({ 
  storage: kycStorage,
  limits: { fileSize: 5 * 1024 * 1024 } // Giới hạn file 5MB để tránh bị spam
}).fields([
  { name: 'cccd_front', maxCount: 1 },
  { name: 'cccd_back', maxCount: 1 },
  { name: 'portrait', maxCount: 1 }
]);

export { cloudinary, uploadKycMiddleware };