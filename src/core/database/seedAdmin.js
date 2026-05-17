import User from '../../modules/identity/models/User.model.js';
import AuthProvider from '../../modules/identity/models/AuthProvider.model.js';
import bcrypt from 'bcryptjs';

const seedAdmin = async () => {
    const hashPassword = await bcrypt.hash("Admin@123", 10);
    const admin = await User.create({
        full_name: "System Admin",
        email: "admin@thotincay.vn",
        role: "ADMIN",
        is_email_verified: true,
        kyc_status: "VERIFIED"
    });
    await AuthProvider.create({
        user_id: admin.id,
        provider: "LOCAL",
        password_hash: hashPassword
    });
    console.log("Admin account created: admin@thotincay.vn / Admin@123");
};

export default seedAdmin;