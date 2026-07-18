const QUOTE_ITEM_TYPES = Object.freeze(['LABOUR', 'MATERIAL', 'OTHER']);
const VARIANCE_REASONS = Object.freeze([
    'ADDITIONAL_DAMAGE_FOUND',
    'CUSTOMER_ADDED_SCOPE',
    'PARTS_OR_MATERIAL_CHANGED',
    'INITIAL_DESCRIPTION_INCOMPLETE',
    'ACCESS_CONDITION_DIFFERENT',
    'OTHER'
]);
const MAX_QUANTITY = 2147483647n; // PostgreSQL INTEGER
const MAX_STORED_VND = 9999999999999n; // DECIMAL(15,2) with integer VND input

const DEFAULT_QUOTE_CONFIG = Object.freeze({
    beforeEvidenceMaxFiles: 5,
    maxItems: 20,
    varianceThresholdPercent: 50,
    maxAmount: 100000000,
    maxDurationMinutes: 43200,
    standardWarrantyDays: 10,
    inspectionNoteMaxLength: 2000,
    quoteTextMaxLength: 2000,
    varianceReasonTextMaxLength: 500,
    itemNameMaxLength: 150,
    itemDescriptionMaxLength: 500,
    itemUnitMaxLength: 30
});

const readPositiveInteger = (value, fallback) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const readNonNegativeInteger = (value, fallback) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

const getQuoteConfig = () => ({
    beforeEvidenceMaxFiles: readPositiveInteger(
        process.env.BEFORE_EVIDENCE_MAX_FILES,
        DEFAULT_QUOTE_CONFIG.beforeEvidenceMaxFiles
    ),
    maxItems: readPositiveInteger(
        process.env.FINAL_QUOTE_MAX_ITEMS,
        DEFAULT_QUOTE_CONFIG.maxItems
    ),
    varianceThresholdPercent: readNonNegativeInteger(
        process.env.FINAL_QUOTE_VARIANCE_THRESHOLD_PERCENT,
        DEFAULT_QUOTE_CONFIG.varianceThresholdPercent
    ),
    maxAmount: readPositiveInteger(
        process.env.FINAL_QUOTE_MAX_AMOUNT,
        DEFAULT_QUOTE_CONFIG.maxAmount
    ),
    maxDurationMinutes: readPositiveInteger(
        process.env.FINAL_QUOTE_MAX_DURATION_MINUTES,
        DEFAULT_QUOTE_CONFIG.maxDurationMinutes
    ),
    standardWarrantyDays: Math.min(
        readNonNegativeInteger(
            process.env.JOB_STANDARD_WARRANTY_DAYS,
            DEFAULT_QUOTE_CONFIG.standardWarrantyDays
        ),
        3650
    ),
    inspectionNoteMaxLength: readPositiveInteger(
        process.env.INSPECTION_NOTE_MAX_LENGTH,
        DEFAULT_QUOTE_CONFIG.inspectionNoteMaxLength
    ),
    quoteTextMaxLength: readPositiveInteger(
        process.env.QUOTE_TEXT_MAX_LENGTH,
        DEFAULT_QUOTE_CONFIG.quoteTextMaxLength
    ),
    varianceReasonTextMaxLength: readPositiveInteger(
        process.env.VARIANCE_REASON_TEXT_MAX_LENGTH,
        DEFAULT_QUOTE_CONFIG.varianceReasonTextMaxLength
    ),
    itemNameMaxLength: DEFAULT_QUOTE_CONFIG.itemNameMaxLength,
    itemDescriptionMaxLength: DEFAULT_QUOTE_CONFIG.itemDescriptionMaxLength,
    itemUnitMaxLength: DEFAULT_QUOTE_CONFIG.itemUnitMaxLength
});

const validationError = (message, code = 'VALIDATION_ERROR') => ({
    valid: false,
    message,
    code
});

const isPlainObject = (value) => (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
);

const normalizeOptionalText = (value, { field, maxLength }) => {
    if (value === undefined || value === null || value === '') {
        return { valid: true, value: null };
    }
    if (typeof value !== 'string') {
        return validationError(`${field} must be plain text.`);
    }
    const normalized = value.trim();
    if (!normalized) return { valid: true, value: null };
    if (normalized.length > maxLength) {
        return validationError(`${field} must not exceed ${maxLength} characters.`);
    }
    return { valid: true, value: normalized };
};

const normalizeNullableInteger = (value, { field, min, max }) => {
    if (value === undefined || value === null || value === '') {
        return { valid: true, value: null };
    }
    const raw = typeof value === 'number' ? String(value) : value;
    if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) {
        return validationError(`${field} must be an integer between ${min} and ${max}.`);
    }
    const parsed = Number(raw.trim());
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
        return validationError(`${field} must be an integer between ${min} and ${max}.`);
    }
    return { valid: true, value: parsed };
};

const parsePositiveInteger = (value, field) => {
    if (value === undefined || value === null || value === '') {
        return validationError(`${field} is required.`);
    }
    if (typeof value === 'number' && !Number.isSafeInteger(value)) {
        return validationError(`${field} must be a positive integer.`);
    }
    const raw = String(value).trim();
    if (!/^\d+$/.test(raw)) return validationError(`${field} must be a positive integer.`);
    const integer = BigInt(raw);
    if (integer <= 0n || integer > MAX_QUANTITY) {
        return validationError(`${field} must be between 1 and ${MAX_QUANTITY}.`);
    }
    return { valid: true, value: integer };
};

const parseVndInteger = (value, field) => {
    if (value === undefined || value === null || value === '') {
        return validationError(`${field} is required.`);
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
        return validationError(`${field} must be a finite VND integer.`);
    }
    const raw = String(value).trim();
    const match = raw.match(/^(\d+)(?:\.0+)?$/);
    if (!match) {
        return validationError(`${field} must be a non-negative VND integer.`);
    }
    return { valid: true, value: BigInt(match[1]) };
};

const formatScaledDecimal = (scaled, scale, { trimTrailingZeros = true } = {}) => {
    const negative = scaled < 0n;
    const absolute = negative ? -scaled : scaled;
    const divisor = 10n ** BigInt(scale);
    const integer = absolute / divisor;
    let fraction = (absolute % divisor).toString().padStart(scale, '0');
    if (trimTrailingZeros) fraction = fraction.replace(/0+$/, '');
    const value = fraction ? `${integer}.${fraction}` : integer.toString();
    return negative ? `-${value}` : value;
};

const parsePositiveBidReference = (value) => {
    if (value === undefined || value === null || value === '') {
        return validationError('Selected Bid reference amount is missing.', 'ACCEPTED_DATA_INCONSISTENT');
    }
    const raw = String(value).trim();
    const match = raw.match(/^(\d+)(?:\.(\d{1,2}))?$/);
    if (!match) {
        return validationError('Selected Bid reference amount is invalid.', 'ACCEPTED_DATA_INCONSISTENT');
    }
    const cents = BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0'));
    if (cents <= 0n) {
        return validationError(
            'Selected Bid reference amount must be greater than zero.',
            'ACCEPTED_DATA_INCONSISTENT'
        );
    }
    return {
        valid: true,
        cents,
        value: formatScaledDecimal(cents, 2)
    };
};

const divideRoundHalfAwayFromZero = (numerator, denominator) => {
    const negative = numerator < 0n;
    const absolute = negative ? -numerator : numerator;
    const rounded = (absolute + (denominator / 2n)) / denominator;
    return negative ? -rounded : rounded;
};

const normalizeQuoteItems = (items, config) => {
    const rawItems = items === undefined || items === null ? [] : items;
    if (!Array.isArray(rawItems)) {
        return validationError('items must be an array.', 'INVALID_QUOTE_ITEM');
    }
    if (rawItems.length > config.maxItems) {
        return validationError(
            `A quote can contain at most ${config.maxItems} items.`,
            'INVALID_QUOTE_ITEM'
        );
    }

    const normalizedItems = [];
    let subtotal = 0n;
    const allowedFields = new Set([
        'item_type',
        'name',
        'description',
        'quantity',
        'unit',
        'unit_price'
    ]);

    for (let index = 0; index < rawItems.length; index += 1) {
        const item = rawItems[index];
        if (!isPlainObject(item)) {
            return validationError(`items[${index}] must be an object.`, 'INVALID_QUOTE_ITEM');
        }
        const unknownFields = Object.keys(item).filter((field) => !allowedFields.has(field));
        if (unknownFields.length > 0) {
            return validationError(
                `items[${index}] contains unsupported fields: ${unknownFields.join(', ')}.`,
                'INVALID_QUOTE_ITEM'
            );
        }
        if (!QUOTE_ITEM_TYPES.includes(item.item_type)) {
            return validationError(`items[${index}].item_type is invalid.`, 'INVALID_QUOTE_ITEM');
        }

        const name = normalizeOptionalText(item.name, {
            field: `items[${index}].name`,
            maxLength: config.itemNameMaxLength
        });
        if (!name.valid || !name.value) {
            return validationError(
                name.message || `items[${index}].name is required.`,
                'INVALID_QUOTE_ITEM'
            );
        }
        const description = normalizeOptionalText(item.description, {
            field: `items[${index}].description`,
            maxLength: config.itemDescriptionMaxLength
        });
        if (!description.valid) return validationError(description.message, 'INVALID_QUOTE_ITEM');
        const unit = normalizeOptionalText(item.unit, {
            field: `items[${index}].unit`,
            maxLength: config.itemUnitMaxLength
        });
        if (!unit.valid || !unit.value) {
            return validationError(
                unit.message || `items[${index}].unit is required.`,
                'INVALID_QUOTE_ITEM'
            );
        }
        const quantity = parsePositiveInteger(item.quantity, `items[${index}].quantity`);
        if (!quantity.valid) return validationError(quantity.message, 'INVALID_QUOTE_ITEM');
        const unitPrice = parseVndInteger(item.unit_price, `items[${index}].unit_price`);
        if (!unitPrice.valid) {
            return validationError(unitPrice.message, 'INVALID_QUOTE_ITEM');
        }
        if (unitPrice.value > MAX_STORED_VND) {
            return validationError(
                `items[${index}].unit_price exceeds database precision.`,
                'INVALID_QUOTE_ITEM'
            );
        }

        const lineTotal = quantity.value * unitPrice.value;
        if (lineTotal > MAX_STORED_VND || subtotal + lineTotal > MAX_STORED_VND) {
            return validationError('Quote subtotal exceeds database precision.', 'INVALID_QUOTE_AMOUNT');
        }
        subtotal += lineTotal;
        normalizedItems.push({
            item_type: item.item_type,
            name: name.value,
            description: description.value,
            quantity: quantity.value.toString(),
            unit: unit.value,
            unit_price: unitPrice.value.toString(),
            line_total: lineTotal.toString(),
            sort_order: index
        });
    }

    return { valid: true, items: normalizedItems, subtotal };
};

const calculateVariance = ({ total, bidReference, thresholdPercent }) => {
    const totalCents = total * 100n;
    const varianceCents = totalCents - bidReference.cents;
    const percentScaled = divideRoundHalfAwayFromZero(
        varianceCents * 100n * 10000n,
        bidReference.cents
    );
    const varianceRequired = totalCents * 100n
        > bidReference.cents * BigInt(100 + thresholdPercent);

    return {
        bid_reference_amount: bidReference.value,
        variance_amount: formatScaledDecimal(varianceCents, 2),
        variance_percent: formatScaledDecimal(percentScaled, 4, { trimTrailingZeros: false }),
        variance_required: varianceRequired
    };
};

const validateDraftPayload = (payload, {
    bidReferenceAmount,
    warrantyDays,
    requireExpectedRevision = true,
    config = getQuoteConfig()
} = {}) => {
    if (!isPlainObject(payload)) {
        return validationError('Request body must be a JSON object.');
    }
    const allowedFields = new Set([
        'expected_draft_revision',
        'problem_summary',
        'inspection_notes',
        'recommended_solution',
        'estimated_duration_minutes',
        'items',
        'variance_reason',
        'variance_reason_text'
    ]);
    const unknownFields = Object.keys(payload).filter((field) => !allowedFields.has(field));
    if (unknownFields.length > 0) {
        return validationError(`Unsupported request fields: ${unknownFields.join(', ')}.`);
    }

    let expectedDraftRevision = null;
    if (requireExpectedRevision) {
        const revision = normalizeNullableInteger(payload.expected_draft_revision, {
            field: 'expected_draft_revision',
            min: 0,
            max: Number.MAX_SAFE_INTEGER
        });
        if (!revision.valid || revision.value === null) {
            return validationError(
                revision.message || 'expected_draft_revision is required.',
                'INVALID_DRAFT_REVISION'
            );
        }
        expectedDraftRevision = revision.value;
    }

    const problemSummary = normalizeOptionalText(payload.problem_summary, {
        field: 'problem_summary',
        maxLength: config.quoteTextMaxLength
    });
    if (!problemSummary.valid) return problemSummary;
    const inspectionNotes = normalizeOptionalText(payload.inspection_notes, {
        field: 'inspection_notes',
        maxLength: config.inspectionNoteMaxLength
    });
    if (!inspectionNotes.valid) return inspectionNotes;
    const recommendedSolution = normalizeOptionalText(payload.recommended_solution, {
        field: 'recommended_solution',
        maxLength: config.quoteTextMaxLength
    });
    if (!recommendedSolution.valid) return recommendedSolution;
    const duration = normalizeNullableInteger(payload.estimated_duration_minutes, {
        field: 'estimated_duration_minutes',
        min: 1,
        max: config.maxDurationMinutes
    });
    if (!duration.valid) {
        return validationError(duration.message, 'INVALID_ESTIMATED_DURATION');
    }
    const warranty = normalizeNullableInteger(
        warrantyDays ?? config.standardWarrantyDays,
        {
        field: 'warranty_days snapshot',
        min: 0,
        max: 3650
    });
    if (!warranty.valid) {
        return validationError(warranty.message, 'INVALID_WARRANTY_DAYS');
    }

    const itemsResult = normalizeQuoteItems(payload.items, config);
    if (!itemsResult.valid) return itemsResult;
    const total = itemsResult.subtotal;
    if (total > BigInt(config.maxAmount)) {
        return validationError(
            `total_amount must not exceed ${config.maxAmount} VND.`,
            'INVALID_QUOTE_AMOUNT'
        );
    }

    const bidReference = parsePositiveBidReference(bidReferenceAmount);
    if (!bidReference.valid) return bidReference;
    const variance = calculateVariance({
        total,
        bidReference,
        thresholdPercent: config.varianceThresholdPercent
    });

    const requestedVarianceReason = payload.variance_reason === undefined
        || payload.variance_reason === null
        || payload.variance_reason === ''
        ? null
        : payload.variance_reason;
    if (requestedVarianceReason !== null && !VARIANCE_REASONS.includes(requestedVarianceReason)) {
        return validationError('variance_reason is invalid.', 'VARIANCE_REASON_REQUIRED');
    }
    const varianceReasonText = normalizeOptionalText(payload.variance_reason_text, {
        field: 'variance_reason_text',
        maxLength: config.varianceReasonTextMaxLength
    });
    if (!varianceReasonText.valid) return varianceReasonText;
    if (variance.variance_required && !requestedVarianceReason && varianceReasonText.value) {
        return validationError(
            'variance_reason is required when variance_reason_text is provided.',
            'VARIANCE_REASON_REQUIRED'
        );
    }
    const varianceReason = variance.variance_required ? requestedVarianceReason : null;
    const canonicalVarianceReasonText = variance.variance_required
        ? varianceReasonText.value
        : null;

    return {
        valid: true,
        expectedDraftRevision,
        data: {
            problem_summary: problemSummary.value,
            inspection_notes: inspectionNotes.value,
            recommended_solution: recommendedSolution.value,
            estimated_duration_minutes: duration.value,
            warranty_days: warranty.value,
            subtotal_amount: itemsResult.subtotal.toString(),
            discount_amount: '0',
            total_amount: total.toString(),
            currency: 'VND',
            bid_reference_amount: variance.bid_reference_amount,
            variance_amount: variance.variance_amount,
            variance_percent: variance.variance_percent,
            variance_reason: varianceReason,
            variance_reason_text: canonicalVarianceReasonText
        },
        items: itemsResult.items,
        varianceRequired: variance.variance_required,
        total
    };
};

const buildSubmitReadiness = ({ normalized, evidenceCount, heldDepositAmount }) => {
    const missing = [];
    if (!normalized?.data?.problem_summary) missing.push('PROBLEM_SUMMARY_REQUIRED');
    if (!normalized?.data?.recommended_solution) missing.push('RECOMMENDED_SOLUTION_REQUIRED');
    if (normalized?.data?.estimated_duration_minutes === null) {
        missing.push('ESTIMATED_DURATION_REQUIRED');
    }
    if (normalized?.data?.warranty_days === null) missing.push('WARRANTY_DAYS_REQUIRED');
    if (!normalized?.items?.length) missing.push('QUOTE_ITEMS_REQUIRED');
    if (!normalized || normalized.total <= 0n) missing.push('INVALID_QUOTE_AMOUNT');
    const heldDeposit = parseVndInteger(heldDepositAmount, 'held deposit');
    if (!heldDeposit.valid || heldDeposit.value <= 0n) {
        missing.push('ACCEPTED_DATA_INCONSISTENT');
    } else if (normalized?.total < heldDeposit.value) {
        missing.push('QUOTE_TOTAL_BELOW_HELD_DEPOSIT');
    }
    if (!Number.isInteger(evidenceCount) || evidenceCount < 1) {
        missing.push('BEFORE_EVIDENCE_REQUIRED');
    }
    if (normalized?.varianceRequired && !normalized.data.variance_reason) {
        missing.push('VARIANCE_REASON_REQUIRED');
    }
    if (normalized?.data?.variance_reason === 'OTHER'
        && !normalized.data.variance_reason_text) {
        missing.push('VARIANCE_REASON_TEXT_REQUIRED');
    }
    return {
        ready: missing.length === 0,
        missing_requirements: missing,
        before_evidence_count: Number.isInteger(evidenceCount) ? evidenceCount : 0,
        variance_reason_required: Boolean(normalized?.varianceRequired),
        minimum_quote_total_amount: heldDeposit.valid ? heldDeposit.value.toString() : null
    };
};

const normalizeStoredQuote = (quote, items, bidReferenceAmount) => {
    if (!quote) return validationError('Quote not found.', 'QUOTE_NOT_FOUND');
    return validateDraftPayload({
        problem_summary: quote.problem_summary,
        inspection_notes: quote.inspection_notes,
        recommended_solution: quote.recommended_solution,
        estimated_duration_minutes: quote.estimated_duration_minutes,
        items: (items || []).map((item) => ({
            item_type: item.item_type,
            name: item.name,
            description: item.description,
            quantity: item.quantity,
            unit: item.unit,
            unit_price: item.unit_price
        })),
        variance_reason: quote.variance_reason,
        variance_reason_text: quote.variance_reason_text
    }, {
        bidReferenceAmount,
        warrantyDays: quote.warranty_days,
        requireExpectedRevision: false
    });
};

const toCanonicalMoneyString = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const raw = String(value).trim();
    const match = raw.match(/^(-?\d+)(?:\.(\d+))?$/);
    if (!match) return raw;
    const fraction = (match[2] || '').replace(/0+$/, '');
    return fraction ? `${match[1]}.${fraction}` : match[1];
};

export {
    QUOTE_ITEM_TYPES,
    VARIANCE_REASONS,
    buildSubmitReadiness,
    getQuoteConfig,
    normalizeStoredQuote,
    parsePositiveBidReference,
    toCanonicalMoneyString,
    validateDraftPayload
};
