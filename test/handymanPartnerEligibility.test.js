import test from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/core/database/connection.js';
import { isOfficialHandymanPartner } from '../src/modules/identity/services/HandymanPartnerEligibility.service.js';

const verifiedHandyman = {
  id: '00000000-0000-4000-8000-000000000001',
  role: 'HANDYMAN',
  is_active: true,
  kyc_status: 'VERIFIED'
};

test.after(() => db.close());

test('requires both Level C3 and a paid security bond', () => {
  assert.equal(isOfficialHandymanPartner({
    user: verifiedHandyman,
    profile: { handyman_level: 'C2', security_bond_status: 'UNPAID' }
  }), false);
  assert.equal(isOfficialHandymanPartner({
    user: verifiedHandyman,
    profile: { handyman_level: 'C3', security_bond_status: 'UNPAID' }
  }), false);
  assert.equal(isOfficialHandymanPartner({
    user: verifiedHandyman,
    profile: { handyman_level: 'C2', security_bond_status: 'PAID' }
  }), false);
  assert.equal(isOfficialHandymanPartner({
    user: verifiedHandyman,
    profile: { handyman_level: 'C3', security_bond_status: 'PAID' }
  }), true);
});

test('rejects inactive, unverified, or non-Handyman accounts', () => {
  const officialProfile = { handyman_level: 'C3', security_bond_status: 'PAID' };
  assert.equal(isOfficialHandymanPartner({
    user: { ...verifiedHandyman, is_active: false },
    profile: officialProfile
  }), false);
  assert.equal(isOfficialHandymanPartner({
    user: { ...verifiedHandyman, kyc_status: 'PENDING' },
    profile: officialProfile
  }), false);
  assert.equal(isOfficialHandymanPartner({
    user: { ...verifiedHandyman, role: 'CUSTOMER' },
    profile: officialProfile
  }), false);
});
