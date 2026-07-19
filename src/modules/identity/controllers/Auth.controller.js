import {
  handleRegisterUser,
  handleLoginUser,
  handleRefreshToken,
  handleLogout,
  handleVerifyEmail,
  handleResendVerifyEmail
} from "../services/Auth.service.js";
import { clearRefreshCookie, setRefreshCookie } from '../utils/authCookie.util.js';

const getAuditContext = (req) => ({
  correlationId: req.correlationId,
  ipAddress: req.ip,
  userAgent: req.get('user-agent') || null
});

const registerNewUser = async (req, res) => {
  try {
    const { email, password, full_name, phone_number, role } = req.body;

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

    if (role && !['CUSTOMER', 'HANDYMAN'].includes(role)) {
      return res.status(400).json({
        EM: "Invalid role. Role must be CUSTOMER or HANDYMAN.",
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
      setRefreshCookie(res, data.DT.refresh_token);
      delete data.DT.refresh_token;
    }

    return res.status(data.EC === 0 ? 200 : data.EC).json({
      EM: data.EM,
      EC: data.EC,
      code: data.code,
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

const loginAdmin = async (req, res) => {
  try {
    const { valueLogin, email, password } = req.body;
    const normalizedLogin = String(valueLogin || email || '').trim();
    if (!normalizedLogin || !password) {
      return res.status(400).json({
        EM: 'Administrator email and password are required.',
        EC: 400,
        code: 'VALIDATION_ERROR',
        DT: ''
      });
    }

    const data = await handleLoginUser(
      { valueLogin: normalizedLogin, password },
      { expectedRole: 'ADMIN', auditContext: getAuditContext(req) }
    );
    if (data.EC === 0) {
      setRefreshCookie(res, data.DT.refresh_token);
      delete data.DT.refresh_token;
    }
    return res.status(data.EC === 0 ? 200 : data.EC).json(data);
  } catch (error) {
    console.error('[admin-login] Login failed unexpectedly.', {
      correlation_id: req.correlationId,
      error: error.message
    });
    return res.status(500).json({
      EM: 'Unable to sign in to the Admin Portal.',
      EC: 500,
      code: 'INTERNAL_SERVER_ERROR',
      DT: ''
    });
  }
};

const getAdminSession = (req, res) => res.status(200).json({
  EM: 'Administrator session retrieved successfully.',
  EC: 0,
  code: 'ADMIN_SESSION_RETRIEVED',
  DT: { user: req.admin.get({ plain: true }) }
});

const requestRefreshToken = async (req, res) => {
  try {
    const cookieToken = req.cookies.refreshToken;

    if (!cookieToken) {
      return res.status(401).json({
        EM: "No refresh token found. Please login again.",
        EC: 401,
        code: 'SESSION_EXPIRED',
        DT: "",
      });
    }

    let data = await handleRefreshToken(cookieToken);

    if (data && data.EC === 0) {
      setRefreshCookie(res, data.DT.refresh_token);
      delete data.DT.refresh_token;
    } else {
      clearRefreshCookie(res);
    }

    const responseStatus = data.EC === 0
      ? 200
      : [401, 403].includes(data.EC) ? data.EC : 500;
    return res.status(responseStatus).json({
      EM: data.EM,
      EC: data.EC,
      code: data.code,
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

    const data = await handleLogout(cookieToken, getAuditContext(req));
    clearRefreshCookie(res);
    return res.status(data.EC === 0 ? 200 : data.EC).json(data);
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
      return res.status(400).json({ 
        EM: "Token is missing.", 
        EC: 400 
      });
    }

    let data = await handleVerifyEmail(token);
    
    return res.status(data.EC === 0 ? 200 : 400).json({
      EM: data.EM,
      EC: data.EC,
    });
  } catch (error) {
    return res.status(500).json({ 
      EM: "Server error", 
      EC: 500 
    });
  }
};

const resendVerifyEmail = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ 
        EM: "Email is required.", 
        EC: 400 
      });
    }

    let data = await handleResendVerifyEmail(email);

    return res.status(data.EC === 0 ? 200 : 400).json({
      EM: data.EM,
      EC: data.EC,
    });
  } catch (error) {
    return res.status(500).json({ 
      EM: "Server error", 
      EC: 500 
    });
  }
};

export {
  getAdminSession,
  loginAdmin,
  loginUser,
  logoutUser,
  registerNewUser,
  requestRefreshToken,
  resendVerifyEmail,
  verifyEmail
};
