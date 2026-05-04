import express from "express";
import { registerNewUser, loginUser, requestRefreshToken, logoutUser } from "../controllers/Auth.controller.js";

const router = express.Router();

router.post("/register", registerNewUser);
router.post("/login", loginUser); 
router.post("/refresh", requestRefreshToken);
router.post("/logout", logoutUser);

export default router;