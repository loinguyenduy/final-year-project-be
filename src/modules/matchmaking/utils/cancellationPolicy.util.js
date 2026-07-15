const CANCELLABLE_JOB_STATUSES = Object.freeze([
    'EN_ROUTE',
    'ARRIVED',
    'QUOTE_PENDING',
    'PAYMENT_PENDING'
]);

const ACTIVE_CANCELLATION_STATUSES = Object.freeze([
    'AWAITING_COUNTERPARTY',
    'REVIEW_REQUIRED'
]);

const ALL_PHASES = CANCELLABLE_JOB_STATUSES;
const ARRIVED_AND_QUOTE = Object.freeze(['ARRIVED', 'QUOTE_PENDING', 'PAYMENT_PENDING']);
const EN_ROUTE_AND_ARRIVED = Object.freeze(['EN_ROUTE', 'ARRIVED']);

const auto = (phases, classification) => ({
    phases,
    classification,
    resolutionMode: 'AUTO_RESOLVE'
});
const review = (phases) => ({
    phases,
    classification: 'DISPUTED',
    resolutionMode: 'ADMIN_REVIEW'
});
const mutual = (phases) => ({
    phases,
    classification: 'NEUTRAL',
    resolutionMode: 'COUNTERPARTY_ACKNOWLEDGEMENT'
});

const CANCELLATION_REASON_POLICY = Object.freeze({
    CUSTOMER: Object.freeze({
        NO_LONGER_NEEDED: auto(ALL_PHASES, 'CUSTOMER_FAULT'),
        WRONG_JOB_INFORMATION: auto(ALL_PHASES, 'CUSTOMER_FAULT'),
        SCOPE_CHANGED: auto(ARRIVED_AND_QUOTE, 'CUSTOMER_FAULT'),
        FINAL_QUOTE_TOO_HIGH: auto(
            ['QUOTE_PENDING', 'PAYMENT_PENDING'],
            'NEUTRAL_QUOTE_REJECTION'
        ),
        FINAL_QUOTE_NOT_ACCEPTABLE: auto(
            ['QUOTE_PENDING', 'PAYMENT_PENDING'],
            'NEUTRAL_QUOTE_REJECTION'
        ),
        HANDYMAN_NOT_PROGRESSING: review(EN_ROUTE_AND_ARRIVED),
        HANDYMAN_NOT_PRESENT: review(['EN_ROUTE']),
        HANDYMAN_UNPROFESSIONAL: review(ALL_PHASES),
        EXTERNAL_CIRCUMSTANCE: auto(ALL_PHASES, 'NEUTRAL'),
        MUTUAL_AGREEMENT: mutual(ALL_PHASES),
        OTHER: review(ALL_PHASES)
    }),
    HANDYMAN: Object.freeze({
        JOB_OUTSIDE_SKILL: auto(ALL_PHASES, 'HANDYMAN_FAULT'),
        EQUIPMENT_OR_PART_UNAVAILABLE: auto(ARRIVED_AND_QUOTE, 'NEUTRAL'),
        CUSTOMER_UNAVAILABLE: review(EN_ROUTE_AND_ARRIVED),
        WRONG_ADDRESS: review(EN_ROUTE_AND_ARRIVED),
        CUSTOMER_REFUSED_ACCESS: review(EN_ROUTE_AND_ARRIVED),
        UNSAFE_WORKING_CONDITION: review(ARRIVED_AND_QUOTE),
        JOB_SCOPE_MISMATCH: review(ARRIVED_AND_QUOTE),
        CUSTOMER_CHANGED_SCOPE: review(ARRIVED_AND_QUOTE),
        EXTERNAL_CIRCUMSTANCE: auto(ALL_PHASES, 'NEUTRAL'),
        MUTUAL_AGREEMENT: mutual(ALL_PHASES),
        OTHER: review(ALL_PHASES)
    })
});

const CUSTOMER_PERCENT_BY_PHASE_AND_CLASSIFICATION = Object.freeze({
    EN_ROUTE: Object.freeze({
        CUSTOMER_FAULT: 50,
        HANDYMAN_FAULT: 100,
        NEUTRAL: 100
    }),
    ARRIVED: Object.freeze({
        CUSTOMER_FAULT: 30,
        HANDYMAN_FAULT: 100,
        NEUTRAL: 50
    }),
    QUOTE_PENDING: Object.freeze({
        CUSTOMER_FAULT: 30,
        HANDYMAN_FAULT: 100,
        NEUTRAL: 50,
        NEUTRAL_QUOTE_REJECTION: 70
    }),
    PAYMENT_PENDING: Object.freeze({
        CUSTOMER_FAULT: 30,
        HANDYMAN_FAULT: 100,
        NEUTRAL: 50,
        NEUTRAL_QUOTE_REJECTION: 70
    })
});

const validateCancellationPayload = (payload, role, phase) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { valid: false, message: 'Request body must be an object.' };
    }

    const unexpectedFields = Object.keys(payload).filter(
        (field) => !['reason', 'reason_text'].includes(field)
    );
    if (unexpectedFields.length > 0) {
        return {
            valid: false,
            message: `Unsupported cancellation fields: ${unexpectedFields.join(', ')}.`
        };
    }

    if (typeof payload.reason !== 'string' || !payload.reason.trim()) {
        return { valid: false, message: 'reason is required.' };
    }
    const reason = payload.reason.trim();
    const rolePolicies = CANCELLATION_REASON_POLICY[role];
    const policy = rolePolicies?.[reason];
    if (!policy) {
        return {
            valid: false,
            message: `reason is not valid for role ${role}.`
        };
    }
    if (!policy.phases.includes(phase)) {
        return {
            valid: false,
            message: `reason ${reason} is not valid while the job is ${phase}.`
        };
    }

    if (payload.reason_text !== undefined
        && payload.reason_text !== null
        && typeof payload.reason_text !== 'string') {
        return { valid: false, message: 'reason_text must be a string.' };
    }
    const reasonText = typeof payload.reason_text === 'string'
        ? payload.reason_text.trim()
        : null;
    if (reason === 'OTHER' && !reasonText) {
        return { valid: false, message: 'reason_text is required when reason is OTHER.' };
    }
    if (reasonText && reasonText.length > 500) {
        return { valid: false, message: 'reason_text must not exceed 500 characters.' };
    }

    return {
        valid: true,
        reason,
        reasonText,
        classification: policy.classification,
        resolutionMode: policy.resolutionMode
    };
};

const validateCounterpartyResponsePayload = (payload = {}) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { valid: false, message: 'Request body must be an object.' };
    }
    const unexpectedFields = Object.keys(payload).filter((field) => field !== 'response_note');
    if (unexpectedFields.length > 0) {
        return {
            valid: false,
            message: `Unsupported response fields: ${unexpectedFields.join(', ')}.`
        };
    }
    if (payload.response_note !== undefined
        && payload.response_note !== null
        && typeof payload.response_note !== 'string') {
        return { valid: false, message: 'response_note must be a string.' };
    }
    const responseNote = typeof payload.response_note === 'string'
        ? payload.response_note.trim()
        : null;
    if (responseNote && responseNote.length > 500) {
        return { valid: false, message: 'response_note must not exceed 500 characters.' };
    }
    return { valid: true, responseNote: responseNote || null };
};

const parseVndInteger = (value) => {
    const normalized = String(value ?? '').trim();
    if (!/^\d+(?:\.0{1,2})?$/.test(normalized)) {
        return { valid: false, amount: null };
    }
    const [integerPart] = normalized.split('.');
    try {
        return { valid: true, amount: BigInt(integerPart) };
    } catch {
        return { valid: false, amount: null };
    }
};

const parseDecimalHundredths = (value) => {
    const normalized = String(value ?? '').trim();
    const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(normalized);
    if (!match) return { valid: false, amount: null };
    const fraction = String(match[2] || '').padEnd(2, '0');
    try {
        return {
            valid: true,
            amount: (BigInt(match[1]) * 100n) + BigInt(fraction || '0')
        };
    } catch {
        return { valid: false, amount: null };
    }
};

const calculateCancellationDistribution = ({ depositAmount, phase, classification }) => {
    if (typeof depositAmount !== 'bigint' || depositAmount <= 0n) {
        return { valid: false, message: 'Deposit amount must be a positive VND integer.' };
    }
    const customerPercent = CUSTOMER_PERCENT_BY_PHASE_AND_CLASSIFICATION[phase]?.[classification];
    if (!Number.isInteger(customerPercent)) {
        return { valid: false, message: 'Cancellation financial policy is not configured.' };
    }

    const customerAmount = ((depositAmount * BigInt(customerPercent)) + 50n) / 100n;
    const handymanAmount = depositAmount - customerAmount;
    return {
        valid: true,
        depositAmount,
        customerAmount,
        handymanAmount,
        platformAmount: 0n,
        customerPercent,
        handymanPercent: 100 - customerPercent
    };
};

const moneyString = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'bigint') return value.toString();
    const parsed = parseVndInteger(value);
    return parsed.valid ? parsed.amount.toString() : null;
};

const buildCancellationDto = (cancellation) => {
    if (!cancellation) return null;
    const record = cancellation.toJSON ? cancellation.toJSON() : cancellation;
    const hasDistribution = record.refund_amount !== null
        && record.refund_amount !== undefined
        && record.handyman_compensation_amount !== null
        && record.handyman_compensation_amount !== undefined
        && record.platform_amount !== null
        && record.platform_amount !== undefined;

    return {
        cancellation_id: record.id,
        job_id: record.job_id,
        acceptance_cycle: record.acceptance_cycle == null
            ? null
            : Number(record.acceptance_cycle),
        requested_by_user_id: record.cancelled_by_user_id,
        requested_by_role: record.cancelled_by_role,
        cancelled_from_status: record.status_when_cancelled,
        reason: record.reason_code,
        reason_text: record.reason_text,
        classification: record.classification,
        resolution_mode: record.resolution_mode,
        status: record.status,
        financial_preview: {
            deposit_amount: moneyString(record.deposit_amount),
            customer_refund_amount: hasDistribution ? moneyString(record.refund_amount) : null,
            handyman_compensation_amount: hasDistribution
                ? moneyString(record.handyman_compensation_amount)
                : null,
            platform_amount: hasDistribution ? moneyString(record.platform_amount) : null,
            funds_status: record.status === 'RESOLVED' ? 'RELEASED' : 'HELD'
        },
        counterparty_response: record.counterparty_response,
        counterparty_response_note: record.counterparty_response_note,
        requested_at: record.requested_at || record.createdAt,
        counterparty_responded_at: record.counterparty_responded_at,
        resolved_at: record.resolved_at
    };
};

export {
    ACTIVE_CANCELLATION_STATUSES,
    CANCELLABLE_JOB_STATUSES,
    CANCELLATION_REASON_POLICY,
    buildCancellationDto,
    calculateCancellationDistribution,
    moneyString,
    parseDecimalHundredths,
    parseVndInteger,
    validateCancellationPayload,
    validateCounterpartyResponsePayload
};
