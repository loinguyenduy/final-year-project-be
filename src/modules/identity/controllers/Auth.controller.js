import {
  handleRegisterUser,
  handleLoginUser,
  handleRefreshToken,
  handleLogout,
  handleVerifyEmail,
  handleResendVerifyEmail
} from "../services/Auth.service.js";

const registerNewUser = async (req, res) => {
  try {
    const { email, password, full_name, phone_number } = req.body;

    if (!email || !password || !full_name) {
      return res.status(400).json({
        EM: "Missing required parameters (email, password, full_name).",
        EC: 400,
        DT: "",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        EM: "Your password must have more than 6 letters.",
        EC: 400,
        DT: "",
      });
    }

    let data = await handleRegisterUser(req.body);

    return res.status(data.EC === 0 ? 200 : data.EC).json({
      EM: data.EM,
      EC: data.EC,
      DT: data.DT,
    });
  } catch (error) {
    console.log("Error in registerNewUser controller: ", error);
    return res.status(500).json({
      EM: "Something went wrong in server...",
      EC: 500,
      DT: "",
    });
  }
};

const loginUser = async (req, res) => {
  try {
    const { valueLogin, password } = req.body;

    if (!valueLogin || !password) {
      return res.status(400).json({
        EM: "Missing your account or password.",
        EC: 400,
        DT: "",
      });
    }

    let data = await handleLoginUser(req.body);

    if (data && data.EC === 0) {
      res.cookie("refreshToken", data.DT.refresh_token, {
        httpOnly: true, // set HttpOnly flag to prevent client-side JS access
        secure: false,
        sameSite: "strict",
        maxAge: process.env.COOKIE_REFRESH_MAX_AGE || 604800000,
      });

      delete data.DT.refresh_token;
    }

    return res.status(data.EC === 0 ? 200 : data.EC).json({
      EM: data.EM,
      EC: data.EC,
      DT: data.DT,
    });
  } catch (error) {
    console.log("Error in loginUser controller: ", error);
    return res.status(500).json({
      EM: "Something went wrong in server...",
      EC: 500,
      DT: "",
    });
  }
};

const requestRefreshToken = async (req, res) => {
  try {
    const cookieToken = req.cookies.refreshToken;

    if (!cookieToken) {
      return res.status(401).json({
        EM: "No refresh token found. Please login again.",
        EC: 401,
        DT: "",
      });
    }

    let data = await handleRefreshToken(cookieToken);

    if (data && data.EC === 0) {
      res.cookie("refreshToken", data.DT.refresh_token, {
        httpOnly: true,
        secure: false,
        sameSite: "strict",
        maxAge: process.env.COOKIE_REFRESH_MAX_AGE || 604800000,
      });

      delete data.DT.refresh_token;
    } else {
      res.clearCookie("refreshToken");
    }

    return res.status(data.EC === 0 ? 200 : data.EC === 403 ? 403 : 401).json({
      EM: data.EM,
      EC: data.EC,
      DT: data.DT,
    });
  } catch (error) {
    console.log("Error in requestRefreshToken controller: ", error);
    return res.status(500).json({
      EM: "Something went wrong...",
      EC: 500,
      DT: "",
    });
  }
};

const logoutUser = async (req, res) => {
  try {
    const cookieToken = req.cookies.refreshToken;

    await handleLogout(cookieToken);

    res.clearCookie("refreshToken");

    return res.status(200).json({
      EM: "Logout successfully.",
      EC: 0,
      DT: "",
    });
  } catch (error) {
    return res.status(500).json({
      EM: "Something went wrong...",
      EC: 500,
      DT: "",
    });
  }
};

const verifyEmail = async (req, res) => {
  try {
    const token = req.query.token; 
    if (!token) {
      return res.status(400).json({ EM: "Token is missing.", EC: 400 });
    }

    let data = await handleVerifyEmail(token);
    
    return res.status(data.EC === 0 ? 200 : 400).json({
      EM: data.EM,
      EC: data.EC,
    });
  } catch (error) {
    return res.status(500).json({ EM: "Server error", EC: 500 });
  }
};

const resendVerifyEmail = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ EM: "Email is required.", EC: 400 });
    }

    let data = await handleResendVerifyEmail(email);

    return res.status(data.EC === 0 ? 200 : 400).json({
      EM: data.EM,
      EC: data.EC,
    });
  } catch (error) {
    return res.status(500).json({ EM: "Server error", EC: 500 });
  }
};

export { registerNewUser, loginUser, requestRefreshToken, logoutUser, verifyEmail, resendVerifyEmail };
