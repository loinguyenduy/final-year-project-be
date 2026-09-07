import User from '../models/User.model.js';
import HandymanProfile from '../models/HandymanProfile.model.js';

const OFFICIAL_HANDYMAN_LEVEL = 'C3';
const OFFICIAL_HANDYMAN_BOND_STATUS = 'PAID';

const isOfficialHandymanPartner = ({ user, profile }) => Boolean(
  user
  && user.role === 'HANDYMAN'
  && user.is_active
  && user.kyc_status === 'VERIFIED'
  && profile
  && profile.handyman_level === OFFICIAL_HANDYMAN_LEVEL
  && profile.security_bond_status === OFFICIAL_HANDYMAN_BOND_STATUS
);


const getOfficialHandymanPartnerEligibility = async (userId, queryOptions = {}) => {
  const [user, profile] = await Promise.all([
    User.findByPk(userId, {
      attributes: ['id', 'role', 'is_active', 'kyc_status'],
      ...queryOptions
    }),
    HandymanProfile.findOne({
      where: { user_id: userId },
      attributes: ['handyman_level', 'security_bond_status'],
      ...queryOptions
    })
  ]);

  return {
    eligible: isOfficialHandymanPartner({ user, profile }),
    user,
    profile
  };
};

const buildOfficialHandymanPartnerRequiredError = (EC = 403) => ({
  EM: 'Complete the 2,000,000 VND security bond to become a Level C3 official partner before receiving new Jobs.',
  EC,
  code: 'HANDYMAN_OFFICIAL_PARTNER_REQUIRED',
  DT: {
    required_level: OFFICIAL_HANDYMAN_LEVEL,
    required_security_bond_status: OFFICIAL_HANDYMAN_BOND_STATUS
  }
});

export {
  OFFICIAL_HANDYMAN_BOND_STATUS,
  OFFICIAL_HANDYMAN_LEVEL,
  buildOfficialHandymanPartnerRequiredError,
  getOfficialHandymanPartnerEligibility,
  isOfficialHandymanPartner
};
