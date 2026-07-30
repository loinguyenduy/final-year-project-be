import { verifyToken } from "../utils/jwt.util.js";
import User from '../../modules/identity/models/User.model.js';

// Protected APIs accept access tokens only. The refresh cookie is reserved for
// /auth/refresh and must never be verified with the access-token secret.
const extractToken = (req) => {
  const authorization = req.headers.authorization;
  if (!authorization || typeof authorization !== "string") return null;

  const [scheme, token] = authorization.trim().split(/\s+/);
  return scheme?.toLowerCase() === "bearer" && token ? token : null;
};

// Check valid JWT and attach user info to request object
const checkUserJWT = async (req, res, next) => {
  try {
    const token = extractToken(req);
    const isAdminRequest = /^\/api\/v1\/(admin(?:\/|$)|auth\/admin\/)/.test(req.originalUrl || '');

    if (!token) {
      return res.status(401).json({
        EM: "Not authenticated the user (Missing Token)",
        EC: 401,
        code: isAdminRequest ? 'ADMIN_AUTH_REQUIRED' : 'AUTH_REQUIRED',
        DT: "",
      });
    }

    const verification = verifyToken(token);

    if (!verification.isValid) {
      return res.status(401).json({
        EM: "Not authenticated the user (Invalid or Expired Token)",
        EC: 401,
        code: isAdminRequest ? 'ADMIN_SESSION_EXPIRED' : 'SESSION_EXPIRED',
        DT: "",
      });
    }

    const decoded = verification.decoded;
    const user = await User.findByPk(decoded.id, {
      attributes: ['id', 'full_name', 'email', 'role', 'is_active', 'auth_version']
    });
    if (!user) {
      return res.status(401).json({ EM: 'This session is no longer valid.', EC: 401, code: 'SESSION_REVOKED', DT: '' });
    }
    if (!user.is_active) {
      return res.status(user.role === 'ADMIN' ? 403 : 401).json({
        EM: 'This account is inactive.',
        EC: user.role === 'ADMIN' ? 403 : 401,
        code: user.role === 'ADMIN' ? 'ADMIN_NOT_ACTIVE' : 'ACCOUNT_INACTIVE',
        DT: ''
      });
    }
    const tokenAuthVersion = Number.isInteger(decoded.auth_version) ? decoded.auth_version : 0;
    if (decoded.role !== user.role || tokenAuthVersion !== Number(user.auth_version || 0)) {
      return res.status(401).json({ EM: 'This session has been revoked. Please login again.', EC: 401, code: 'SESSION_REVOKED', DT: '' });
    }
    req.authenticatedUser = user;
    req.user = {
      id: user.id, full_name: user.full_name, email: user.email,
      role: user.role, auth_version: Number(user.auth_version || 0)
    };
    return next();
  } catch (error) {
    console.log("Error in checkUserJWT middleware:", error);
    return res.status(500).json({
      EM: "Something went wrong at the gateway...",
      EC: 500,
      code: 'INTERNAL_SERVER_ERROR',
      DT: "",
    });
  }
};

// Authorize based on user role
const checkUserRole = (allowedRoles) => {
  return (req, res, next) => {
    try {
      if (req.user && req.user.role) {
        if (allowedRoles.includes(req.user.role)) {
          next();
        } else {
          return res.status(403).json({
            EM: "You don't have permission to access this resource",
            EC: 403,
            DT: "",
          });
        }
      } else {
        return res.status(401).json({
          EM: "Not authenticated the user",
          EC: 401,
          DT: "",
        });
      }
    } catch (error) {
      console.log("Error in checkUserRole:", error);
      return res.status(500).json({ EM: "Server Error", EC: 500 });
    }
  };
};

export { checkUserJWT, checkUserRole };
