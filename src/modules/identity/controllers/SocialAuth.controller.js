import { upsertGoogleUser, upsertFacebookUser } from "../services/SocialAuth.service.js";

const handleGoogleCallback = async (req, res) => {
  try {
    // req.user is data returned from Passport's Google Strategy 
    const googleProfile = req.user;

    if (!googleProfile) {
      return res.status(401).json({ EM: "Google authentication failed", EC: 401 });
    }

    const data = await upsertGoogleUser(googleProfile);

    if (data.EC === 0) {
      res.cookie("refreshToken", data.DT.refresh_token, {
        httpOnly: true,
        secure: false,
        sameSite: "strict",
        maxAge: process.env.COOKIE_REFRESH_MAX_AGE || 604800000,
      });

      delete data.DT.refresh_token;

      // Ở sản phẩm thật, chỗ này sẽ là res.redirect('http://localhost:5173/login-success?token=' + data.DT.access_token)
      return res.status(200).json({
        EM: data.EM,
        EC: data.EC,
        DT: data.DT,
      });
    } else {
      return res.status(500).json({ 
        EM: data.EM, 
        EC: data.EC 
      });
    }
  } catch (error) {
    console.log("Error in handleGoogleCallback controller: ", error);
    return res.status(500).json({ 
      EM: "Server error", 
      EC: 500 
    });
  }
};

const handleFacebookCallback = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ EM: "Facebook authentication failed", EC: 401 });
    }

    const data = await upsertFacebookUser(req.user);

    if (data.EC === 0) {
      res.cookie("refreshToken", data.DT.refresh_token, {
        httpOnly: true,
        secure: false,
        sameSite: "strict",
        maxAge: process.env.COOKIE_REFRESH_MAX_AGE || 604800000,
      });

      delete data.DT.refresh_token;

      return res.status(200).json({
        EM: data.EM,
        EC: data.EC,
        DT: data.DT,
      });
    }

    return res.status(data.EC).json({ EM: data.EM, EC: data.EC });
  } catch (error) {
    console.log("Error FB Controller: ", error);
    return res.status(500).json({ EM: "Server error", EC: 500 });
  }
};

export { handleGoogleCallback, handleFacebookCallback };