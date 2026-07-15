import { randomUUID } from 'node:crypto';
import { parseVndInteger } from './cancellationPolicy.util.js';
import { toCanonicalMoneyString } from './quote.util.js';

const QUOTE_REJECTION_REASONS = Object.freeze([
    'FINAL_QUOTE_TOO_HIGH',
    'FINAL_QUOTE_NOT_ACCEPTABLE'
]);

const validateEmptyObjectPayload = (payload, actionName) => {
    if (!payload
        || typeof payload !== 'object'
        || Array.isArray(payload)
        || Object.keys(payload).length > 0) {
        return {
            valid: false,
            message: `${actionName} body must be an empty JSON object.`
        };
    }
    return { valid: true };
};

const validateQuoteRejectionPayload = (payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { valid: false, message: 'Reject Quote body must be a JSON object.' };
    }
    const unknownFields = Object.keys(payload).filter(
        (field) => !['reason', 'reason_text'].includes(field)
    );
    if (unknownFields.length > 0) {
        return {
            valid: false,
            message: `Unsupported reject Quote fields: ${unknownFields.join(', ')}.`
        };
    }
    if (!QUOTE_REJECTION_REASONS.includes(payload.reason)) {
        return {
            valid: false,
            message: 'reason must be FINAL_QUOTE_TOO_HIGH or FINAL_QUOTE_NOT_ACCEPTABLE.'
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
    if (reasonText && reasonText.length > 500) {
        return { valid: false, message: 'reason_text must not exceed 500 characters.' };
    }
    return {
        valid: true,
        reason: payload.reason,
        reasonText: reasonText || null
    };
};

const calculateQuotePaymentAmounts = ({
    quoteTotalAmount,
    jobDepositAmount,
    depositTransactionAmount
}) => {
    const quoteTotal = typeof quoteTotalAmount === 'bigint'
        ? { valid: true, amount: quoteTotalAmount }
        : parseVndInteger(quoteTotalAmount);
    const jobDeposit = parseVndInteger(jobDepositAmount);
    const transactionDeposit = parseVndInteger(depositTransactionAmount);

    if (!quoteTotal.valid || quoteTotal.amount <= 0n) {
        return {
            valid: false,
            code: 'FINANCIAL_DATA_INCONSISTENT',
            message: 'Quote total must be a positive VND integer.'
        };
    }
    if (!jobDeposit.valid
        || jobDeposit.amount <= 0n
        || !transactionDeposit.valid
        || transactionDeposit.amount !== jobDeposit.amount) {
        return {
            valid: false,
            code: 'FINANCIAL_DATA_INCONSISTENT',
            message: 'Job deposit and deposit transaction are inconsistent.'
        };
    }
    if (jobDeposit.amount > quoteTotal.amount) {
        return {
            valid: false,
            code: 'FINANCIAL_DATA_INCONSISTENT',
            message: 'The held deposit exceeds the accepted Quote total.'
        };
    }

    return {
        valid: true,
        quoteTotal: quoteTotal.amount,
        depositAmount: jobDeposit.amount,
        remainingAmount: quoteTotal.amount - jobDeposit.amount
    };
};

const createContractIdentity = (now = new Date()) => {
    const id = randomUUID();
    const suffix = id.replaceAll('-', '').slice(0, 12).toUpperCase();
    return {
        id,
        contractNumber: `TTC-${now.getUTCFullYear()}-${suffix}`
    };
};

const buildQuoteItemSnapshot = (item) => ({
    item_type: item.item_type,
    description: item.description,
    quantity: toCanonicalMoneyString(item.quantity),
    unit: item.unit,
    unit_price: toCanonicalMoneyString(item.unit_price),
    line_total: toCanonicalMoneyString(item.line_total),
    sort_order: Number(item.sort_order)
});

const buildPaymentSummaryDto = ({ job, quote, contract, amounts }) => ({
    job_id: job.id,
    quote_id: quote.id,
    acceptance_cycle: Number(job.acceptance_cycle),
    currency: quote.currency,
    quote_total_amount: amounts.quoteTotal.toString(),
    deposit_amount: amounts.depositAmount.toString(),
    remaining_amount: amounts.remainingAmount.toString(),
    status: contract?.status === 'ACTIVE' ? 'COMPLETED' : 'PENDING',
    payment_completed_at: contract?.payment_completed_at || null
});

const buildContractSummaryDto = (contract) => contract ? ({
    id: contract.id,
    contract_number: contract.contract_number,
    status: contract.status,
    effective_at: contract.effective_at
}) : null;

const buildContractDto = (contract) => {
    if (!contract) return null;
    return {
        id: contract.id,
        job_id: contract.job_id,
        acceptance_cycle: Number(contract.acceptance_cycle),
        quote_id: contract.quote_id,
        contract_number: contract.contract_number,
        status: contract.status,
        currency: contract.currency,
        subtotal_amount: toCanonicalMoneyString(contract.subtotal_amount),
        discount_amount: toCanonicalMoneyString(contract.discount_amount),
        quote_total_amount: toCanonicalMoneyString(contract.quote_total_amount),
        deposit_amount: toCanonicalMoneyString(contract.deposit_amount),
        remaining_payment_amount: toCanonicalMoneyString(
            contract.remaining_payment_amount
        ),
        full_escrow_amount: toCanonicalMoneyString(contract.full_escrow_amount),
        problem_summary: contract.problem_summary,
        inspection_notes: contract.inspection_notes,
        recommended_solution: contract.recommended_solution,
        estimated_duration_minutes: Number(contract.estimated_duration_minutes),
        warranty_days: Number(contract.warranty_days),
        bid_reference_amount: toCanonicalMoneyString(contract.bid_reference_amount),
        variance_amount: toCanonicalMoneyString(contract.variance_amount),
        variance_percent: toCanonicalMoneyString(contract.variance_percent),
        variance_reason: contract.variance_reason,
        variance_reason_text: contract.variance_reason_text,
        items: Array.isArray(contract.quote_items_snapshot)
            ? contract.quote_items_snapshot
            : [],
        customer_name: contract.customer_name_snapshot,
        handyman_name: contract.handyman_name_snapshot,
        service_address: contract.service_address_snapshot,
        customer_accepted_at: contract.customer_accepted_at,
        payment_completed_at: contract.payment_completed_at,
        effective_at: contract.effective_at,
        created_at: contract.createdAt
    };
};

export {
    QUOTE_REJECTION_REASONS,
    buildContractDto,
    buildContractSummaryDto,
    buildPaymentSummaryDto,
    buildQuoteItemSnapshot,
    calculateQuotePaymentAmounts,
    createContractIdentity,
    validateEmptyObjectPayload,
    validateQuoteRejectionPayload
};
