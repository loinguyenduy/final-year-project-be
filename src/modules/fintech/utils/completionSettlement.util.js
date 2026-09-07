const HANDYMAN_PERCENTAGE = 70;
const PLATFORM_FEE_PERCENTAGE = 15;
const WARRANTY_PERCENTAGE = 15;

const calculateCompletionSplit = (total) => {
    if (typeof total !== 'bigint' || total <= 0n) {
        return { valid: false, code: 'FINANCIAL_DATA_INCONSISTENT' };
    }

    const handymanAmount = (total * BigInt(HANDYMAN_PERCENTAGE)) / 100n;
    const platformAmount = (total * BigInt(PLATFORM_FEE_PERCENTAGE)) / 100n;
    const warrantyAmount = total - handymanAmount - platformAmount;

    return {
        valid: handymanAmount > 0n && platformAmount > 0n && warrantyAmount > 0n,
        code: 'FINANCIAL_DATA_INCONSISTENT',
        total,
        handymanAmount,
        platformAmount,
        warrantyAmount
    };
};

export {
    HANDYMAN_PERCENTAGE,
    PLATFORM_FEE_PERCENTAGE,
    WARRANTY_PERCENTAGE,
    calculateCompletionSplit
};
