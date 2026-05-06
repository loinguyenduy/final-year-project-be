import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import dotenv from "dotenv";
import { Strategy as FacebookStrategy } from "passport-facebook"; 

dotenv.config();

// Cấu hình Google Strategy
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_REDIRECT_URI,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        // profile chứa toàn bộ thông tin Google trả về (email, tên, ảnh)
        // accessToken và refreshToken ở đây là của Google cấp, ta không cần dùng đến nó.
        // Ta chỉ cần pass cái 'profile' này đi tiếp.
        return done(null, profile);
      } catch (error) {
        return done(error, null);
      }
    }
  )
);

passport.use(
  new FacebookStrategy(
    {
      clientID: process.env.FACEBOOK_APP_ID,
      clientSecret: process.env.FACEBOOK_APP_SECRET,
      callbackURL: process.env.FACEBOOK_REDIRECT_URI,
      profileFields: ['id', 'displayName', 'photos', 'email'], 
    },
    async (accessToken, refreshToken, profile, done) => {
      try { return done(null, profile); } 
      catch (error) { return done(error, null); }
    }
  )
);

export default passport;