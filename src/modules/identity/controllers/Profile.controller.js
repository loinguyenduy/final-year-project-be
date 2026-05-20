import { getDetailedProfileService } from "../services/Profile.service.js";

const handleGetUserProfile = async (req, res) => {
    try {
        // req.user.id được nạp sẵn từ middleware checkUserJWT ở tầng route
        const userId = req.user.id;

        const result = await getDetailedProfileService(userId);

        return res.status(result.EC === 0 ? 200 : result.EC).json({
            EM: result.EM,
            EC: result.EC,
            DT: result.DT
        });

    } catch (error) {
        console.error(">>> Error in handleGetUserProfile controller: ", error);
        return res.status(500).json({
            EM: "Internal server error.",
            EC: 500,
            DT: ""
        });
    }
};

export { handleGetUserProfile };