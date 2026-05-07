import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const sendVerificationEmail = async (toEmail, fullName, verifyToken) => {
  const verificationLink = `http://localhost:5173/verify-email?token=${verifyToken}`;

  const mailOptions = {
    from: `"The Trusted Handyman" <${process.env.EMAIL_FROM}>`,
    to: toEmail,
    subject: "Action Required: Verify Your Email Address",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
        <h2 style="color: #2b6cb0; text-align: center;">Welcome to The Trusted Handyman!</h2>
        <p>Hi <strong>${fullName}</strong>,</p>
        <p>Thank you for registering. To complete your setup and ensure the security of your account, please verify your email address by clicking the button below:</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${verificationLink}" style="background-color: #2b6cb0; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: bold;">Verify My Email</a>
        </div>
        <p>Or copy and paste this link into your browser:</p>
        <p style="word-break: break-all; color: #718096; font-size: 14px;">${verificationLink}</p>
        <p><em>This link will expire in 15 minutes.</em></p>
        <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
        <p style="font-size: 12px; color: #a0aec0; text-align: center;">If you did not request this, please ignore this email.</p>
      </div>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Verification email sent to ${toEmail}`);
  } catch (error) {
    console.log("Error sending verification email: ", error);
  }
};

export { sendVerificationEmail };