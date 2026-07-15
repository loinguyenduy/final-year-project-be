import db from './connection.js';

import User from '../../modules/identity/models/User.model.js';
import AuthProvider from '../../modules/identity/models/AuthProvider.model.js';
import UserAddress from '../../modules/identity/models/UserAddress.model.js';
import KycRequest from '../../modules/identity/models/KycRequest.model.js';
import HandymanProfile from '../../modules/identity/models/HandymanProfile.model.js';
import VerificationToken from '../../modules/identity/models/VerificationToken.model.js';
import RefreshToken from '../../modules/identity/models/RefreshToken.model.js';

import Province from '../../modules/matchmaking/models/Province.model.js';
import Ward from '../../modules/matchmaking/models/Ward.model.js';
import Service from '../../modules/matchmaking/models/Service.model.js';
import Job from '../../modules/matchmaking/models/Job.model.js';
import Bid from '../../modules/matchmaking/models/Bid.model.js';
import JobStatusHistory from '../../modules/matchmaking/models/JobStatusHistory.model.js';
import JobCancellation from '../../modules/matchmaking/models/JobCancellation.model.js';
import JobArrivalRequest from '../../modules/matchmaking/models/JobArrivalRequest.model.js';
import JobQuote from '../../modules/matchmaking/models/JobQuote.model.js';
import JobQuoteItem from '../../modules/matchmaking/models/JobQuoteItem.model.js';
import HandymanService from '../../modules/matchmaking/models/HandymanService.model.js';
import HandymanServiceArea from '../../modules/matchmaking/models/HandymanServiceArea.model.js';

import Wallet from '../../modules/fintech/models/Wallet.model.js';
import Transaction from '../../modules/fintech/models/Transaction.model.js';
import EvidenceVault from '../../modules/fintech/models/EvidenceVault.model.js';
import EContract from '../../modules/fintech/models/EContract.model.js';
import Review from '../../modules/dispute/models/Review.model.js';
import Conversation from '../../modules/chat/models/Conversation.model.js';
import Message from '../../modules/chat/models/Message.model.js';

// A. IDENTITY & USER ASSOCIATIONS
User.hasMany(AuthProvider, { foreignKey: 'user_id' });
AuthProvider.belongsTo(User, { foreignKey: 'user_id' });

User.hasMany(UserAddress, { foreignKey: 'user_id' });
UserAddress.belongsTo(User, { foreignKey: 'user_id' });

User.hasOne(HandymanProfile, { foreignKey: 'user_id', primaryKey: true });
HandymanProfile.belongsTo(User, { foreignKey: 'user_id' });

User.hasMany(KycRequest, { as: 'KycDocuments', foreignKey: 'user_id' });
KycRequest.belongsTo(User, { as: 'Owner', foreignKey: 'user_id' });

User.hasMany(KycRequest, { as: 'ReviewedRequests', foreignKey: 'reviewed_by_admin_id' });
KycRequest.belongsTo(User, { as: 'Admin', foreignKey: 'reviewed_by_admin_id' });

User.hasMany(RefreshToken, { foreignKey: 'user_id' });
RefreshToken.belongsTo(User, { foreignKey: 'user_id' });

User.hasOne(VerificationToken, { foreignKey: 'user_id' });
VerificationToken.belongsTo(User, { foreignKey: 'user_id' });

// B. GEOGRAPHY (PROVINCES & WARDS) ASSOCIATIONS
Province.hasMany(Ward, { foreignKey: 'province_code', sourceKey: 'province_code' });
Ward.belongsTo(Province, { foreignKey: 'province_code', targetKey: 'province_code' });

// Liên kết địa chỉ người dùng với hệ thống hành chính
Province.hasMany(UserAddress, { foreignKey: 'province_code', sourceKey: 'province_code' });
UserAddress.belongsTo(Province, { foreignKey: 'province_code', targetKey: 'province_code' });

Ward.hasMany(UserAddress, { foreignKey: 'ward_code', sourceKey: 'ward_code' });
UserAddress.belongsTo(Ward, { foreignKey: 'ward_code', targetKey: 'ward_code' });

// Liên kết Job với hệ thống hành chính để Matchmaking
Province.hasMany(Job, { foreignKey: 'province_code', sourceKey: 'province_code' });
Job.belongsTo(Province, { foreignKey: 'province_code', targetKey: 'province_code' });

Ward.hasMany(Job, { foreignKey: 'ward_code', sourceKey: 'ward_code' });
Job.belongsTo(Ward, { foreignKey: 'ward_code', targetKey: 'ward_code' });

// C. HANDYMAN SPECIALIZATIONS & SERVICE AREAS
User.hasMany(HandymanService, { as: 'Handyman_Services', foreignKey: 'handyman_id' });
HandymanService.belongsTo(User, { foreignKey: 'handyman_id' });
Service.hasMany(HandymanService, { foreignKey: 'service_id' });
HandymanService.belongsTo(Service, { foreignKey: 'service_id' });

User.hasMany(HandymanServiceArea, { as: 'Handyman_Service_Areas', foreignKey: 'handyman_id' });
HandymanServiceArea.belongsTo(User, { foreignKey: 'handyman_id' });
Province.hasMany(HandymanServiceArea, { foreignKey: 'province_code', sourceKey: 'province_code' });
HandymanServiceArea.belongsTo(Province, { foreignKey: 'province_code', targetKey: 'province_code' });
Ward.hasMany(HandymanServiceArea, { foreignKey: 'ward_code', sourceKey: 'ward_code' });
HandymanServiceArea.belongsTo(Ward, { foreignKey: 'ward_code', targetKey: 'ward_code' });

// D. MATCHMAKING (JOBS, SERVICES, BIDS)
Service.hasMany(Job, { foreignKey: 'service_id' });
Job.belongsTo(Service, { foreignKey: 'service_id' });

User.hasMany(Job, { foreignKey: 'customer_id' });
Job.belongsTo(User, { as: 'Customer', foreignKey: 'customer_id' });

User.hasMany(Job, { foreignKey: 'selected_handyman_id' });
Job.belongsTo(User, { as: 'SelectedHandyman', foreignKey: 'selected_handyman_id' });

Job.hasMany(Bid, { foreignKey: 'job_id' });
Bid.belongsTo(Job, { foreignKey: 'job_id' });

Bid.hasOne(Job, { as: 'SelectedForJob', foreignKey: 'selected_bid_id' });
Job.belongsTo(Bid, { as: 'SelectedBid', foreignKey: 'selected_bid_id' });

User.hasMany(Bid, { foreignKey: 'handyman_id' });
Bid.belongsTo(User, { foreignKey: 'handyman_id' });

Job.hasMany(JobQuote, { as: 'Quotes', foreignKey: 'job_id' });
JobQuote.belongsTo(Job, { foreignKey: 'job_id' });

User.hasMany(JobQuote, { as: 'CustomerQuotes', foreignKey: 'customer_id' });
JobQuote.belongsTo(User, { as: 'Customer', foreignKey: 'customer_id' });

User.hasMany(JobQuote, { as: 'HandymanQuotes', foreignKey: 'handyman_id' });
JobQuote.belongsTo(User, { as: 'Handyman', foreignKey: 'handyman_id' });

User.hasMany(JobQuote, { as: 'RespondedQuotes', foreignKey: 'customer_response_by_user_id' });
JobQuote.belongsTo(User, { as: 'CustomerResponseBy', foreignKey: 'customer_response_by_user_id' });

Bid.hasMany(JobQuote, { as: 'InspectionQuotes', foreignKey: 'selected_bid_id' });
JobQuote.belongsTo(Bid, { as: 'SelectedBid', foreignKey: 'selected_bid_id' });

JobQuote.hasMany(JobQuoteItem, {
    as: 'Items',
    foreignKey: 'quote_id',
    onDelete: 'CASCADE'
});
JobQuoteItem.belongsTo(JobQuote, { foreignKey: 'quote_id' });

Job.hasMany(JobStatusHistory, { foreignKey: 'job_id' });
JobStatusHistory.belongsTo(Job, { foreignKey: 'job_id' });

User.hasMany(JobStatusHistory, { foreignKey: 'changed_by_user_id' });
JobStatusHistory.belongsTo(User, { foreignKey: 'changed_by_user_id' });

Job.hasMany(JobCancellation, { foreignKey: 'job_id' });
JobCancellation.belongsTo(Job, { foreignKey: 'job_id' });

User.hasMany(JobCancellation, { foreignKey: 'cancelled_by_user_id' });
JobCancellation.belongsTo(User, { as: 'CancelledByUser', foreignKey: 'cancelled_by_user_id' });

User.hasMany(JobCancellation, {
    as: 'CounterpartyRespondedCancellations',
    foreignKey: 'counterparty_responded_by_user_id'
});
JobCancellation.belongsTo(User, {
    as: 'CounterpartyRespondedBy',
    foreignKey: 'counterparty_responded_by_user_id'
});

User.hasMany(JobCancellation, { as: 'ResolvedCancellations', foreignKey: 'resolved_by_user_id' });
JobCancellation.belongsTo(User, { as: 'ResolvedBy', foreignKey: 'resolved_by_user_id' });

Job.hasMany(JobArrivalRequest, { as: 'ArrivalRequests', foreignKey: 'job_id' });
JobArrivalRequest.belongsTo(Job, { foreignKey: 'job_id' });

User.hasMany(JobArrivalRequest, { as: 'CustomerArrivalRequests', foreignKey: 'customer_id' });
JobArrivalRequest.belongsTo(User, { as: 'Customer', foreignKey: 'customer_id' });

User.hasMany(JobArrivalRequest, { as: 'HandymanArrivalRequests', foreignKey: 'handyman_id' });
JobArrivalRequest.belongsTo(User, { as: 'Handyman', foreignKey: 'handyman_id' });

User.hasMany(JobArrivalRequest, { as: 'RespondedArrivalRequests', foreignKey: 'responded_by_user_id' });
JobArrivalRequest.belongsTo(User, { as: 'RespondedBy', foreignKey: 'responded_by_user_id' });

User.hasMany(Job, { as: 'ArrivalConfirmedJobs', foreignKey: 'arrival_confirmed_by_user_id' });
Job.belongsTo(User, { as: 'ArrivalConfirmedBy', foreignKey: 'arrival_confirmed_by_user_id' });

// E. CHAT
Job.hasMany(Conversation, { as: 'ChatConversations', foreignKey: 'job_id' });
Conversation.belongsTo(Job, { foreignKey: 'job_id' });

User.hasMany(Conversation, { as: 'CustomerChatConversations', foreignKey: 'customer_id' });
Conversation.belongsTo(User, { as: 'Customer', foreignKey: 'customer_id' });

User.hasMany(Conversation, { as: 'HandymanChatConversations', foreignKey: 'handyman_id' });
Conversation.belongsTo(User, { as: 'Handyman', foreignKey: 'handyman_id' });

User.hasMany(Conversation, { as: 'ClosedChatConversations', foreignKey: 'closed_by_user_id' });
Conversation.belongsTo(User, { as: 'ClosedByUser', foreignKey: 'closed_by_user_id' });

Bid.hasMany(Conversation, { as: 'ChatConversations', foreignKey: 'selected_bid_id' });
Conversation.belongsTo(Bid, { as: 'SelectedBid', foreignKey: 'selected_bid_id' });

Conversation.hasMany(Message, { as: 'Messages', foreignKey: 'conversation_id' });
Message.belongsTo(Conversation, { foreignKey: 'conversation_id' });

User.hasMany(Message, { as: 'SentChatMessages', foreignKey: 'sender_id' });
Message.belongsTo(User, { as: 'Sender', foreignKey: 'sender_id' });

// F. FINTECH (WALLET, TRANSACTION, EVIDENCE)
User.hasMany(Wallet, { foreignKey: 'user_id' });
Wallet.belongsTo(User, { foreignKey: 'user_id' });

Wallet.hasMany(Transaction, { foreignKey: 'from_wallet_id' });
Transaction.belongsTo(Wallet, { as: 'FromWallet', foreignKey: 'from_wallet_id' });

Wallet.hasMany(Transaction, { foreignKey: 'to_wallet_id' });
Transaction.belongsTo(Wallet, { as: 'ToWallet', foreignKey: 'to_wallet_id' });

Job.hasMany(Transaction, { foreignKey: 'job_id' });
Transaction.belongsTo(Job, { foreignKey: 'job_id' });

Transaction.hasOne(Job, { as: 'DepositForJob', foreignKey: 'deposit_transaction_id' });
Job.belongsTo(Transaction, { as: 'DepositTransaction', foreignKey: 'deposit_transaction_id' });

Transaction.hasMany(Transaction, { as: 'RefundTransactions', foreignKey: 'reference_transaction_id' });
Transaction.belongsTo(Transaction, { as: 'ReferenceTransaction', foreignKey: 'reference_transaction_id' });

JobCancellation.hasMany(Transaction, { as: 'PayoutTransactions', foreignKey: 'cancellation_id' });
Transaction.belongsTo(JobCancellation, { as: 'Cancellation', foreignKey: 'cancellation_id' });

JobQuote.hasMany(Transaction, { as: 'PaymentTransactions', foreignKey: 'quote_id' });
Transaction.belongsTo(JobQuote, { as: 'Quote', foreignKey: 'quote_id' });

User.hasMany(Transaction, { as: 'PaidTransactions', foreignKey: 'payer_user_id' });
Transaction.belongsTo(User, { as: 'Payer', foreignKey: 'payer_user_id' });

Transaction.hasMany(JobCancellation, {
    as: 'CustomerRefundCancellations',
    foreignKey: 'customer_refund_transaction_id'
});
JobCancellation.belongsTo(Transaction, {
    as: 'CustomerRefundTransaction',
    foreignKey: 'customer_refund_transaction_id'
});

Transaction.hasMany(JobCancellation, {
    as: 'HandymanCompensationCancellations',
    foreignKey: 'handyman_compensation_transaction_id'
});
JobCancellation.belongsTo(Transaction, {
    as: 'HandymanCompensationTransaction',
    foreignKey: 'handyman_compensation_transaction_id'
});

Transaction.hasMany(JobCancellation, {
    as: 'PlatformCancellationFees',
    foreignKey: 'platform_transaction_id'
});
JobCancellation.belongsTo(Transaction, {
    as: 'PlatformTransaction',
    foreignKey: 'platform_transaction_id'
});

Job.hasMany(EvidenceVault, { as: 'EvidenceVaults', foreignKey: 'job_id' });
EvidenceVault.belongsTo(Job, { foreignKey: 'job_id' });

User.hasMany(EvidenceVault, { as: 'UploadedEvidence', foreignKey: 'uploader_id' });
EvidenceVault.belongsTo(User, { as: 'Uploader', foreignKey: 'uploader_id' });

User.hasMany(EvidenceVault, { as: 'CustomerEvidence', foreignKey: 'customer_id' });
EvidenceVault.belongsTo(User, { as: 'Customer', foreignKey: 'customer_id' });

User.hasMany(EvidenceVault, { as: 'HandymanEvidence', foreignKey: 'handyman_id' });
EvidenceVault.belongsTo(User, { as: 'Handyman', foreignKey: 'handyman_id' });

Bid.hasMany(EvidenceVault, { as: 'EvidenceVaults', foreignKey: 'selected_bid_id' });
EvidenceVault.belongsTo(Bid, { as: 'SelectedBid', foreignKey: 'selected_bid_id' });

Job.hasMany(EContract, { as: 'ServiceContracts', foreignKey: 'job_id' });
EContract.belongsTo(Job, { foreignKey: 'job_id' });

JobQuote.hasOne(EContract, { as: 'ServiceContract', foreignKey: 'quote_id' });
EContract.belongsTo(JobQuote, { as: 'Quote', foreignKey: 'quote_id' });

User.hasMany(EContract, { as: 'CustomerContracts', foreignKey: 'customer_id' });
EContract.belongsTo(User, { as: 'Customer', foreignKey: 'customer_id' });

User.hasMany(EContract, { as: 'HandymanContracts', foreignKey: 'handyman_id' });
EContract.belongsTo(User, { as: 'Handyman', foreignKey: 'handyman_id' });

Bid.hasMany(EContract, { as: 'ServiceContracts', foreignKey: 'selected_bid_id' });
EContract.belongsTo(Bid, { as: 'SelectedBid', foreignKey: 'selected_bid_id' });

Transaction.hasOne(EContract, {
    as: 'ActivatedContract',
    foreignKey: 'remaining_payment_transaction_id'
});
EContract.belongsTo(Transaction, {
    as: 'RemainingPaymentTransaction',
    foreignKey: 'remaining_payment_transaction_id'
});

// G. DISPUTE & REVIEWS
Job.hasMany(Review, { foreignKey: 'job_id' });
Review.belongsTo(Job, { foreignKey: 'job_id' });
const verifyChatIndexes = async () => {
    const [indexes] = await db.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename = 'Conversations'
          AND indexname IN (
            'conversations_job_acceptance_cycle_unique',
            'conversations_one_active_per_job'
          )
    `);
    const byName = new Map(indexes.map((index) => [index.indexname, index.indexdef]));
    const cycleIndex = String(byName.get('conversations_job_acceptance_cycle_unique') || '');
    const activeIndex = String(byName.get('conversations_one_active_per_job') || '');

    if (!cycleIndex.includes('UNIQUE')
        || !cycleIndex.includes('job_id')
        || !cycleIndex.includes('acceptance_cycle')) {
        throw new Error(
            'Required chat constraint conversations_job_acceptance_cycle_unique was not created by sync alter.'
        );
    }
    if (!activeIndex.includes('UNIQUE')
        || !activeIndex.includes('WHERE')
        || !activeIndex.includes('ACTIVE')) {
        console.error(
            '[chat] WARNING: sync alter did not create partial unique index '
            + 'conversations_one_active_per_job. Service locking remains active, but the defense-in-depth '
            + 'database constraint is missing.'
        );
    } else {
        console.log('Chat conversation indexes verified successfully.');
    }
};

const reportIndexSyncFailure = (error) => {
    const errorText = [
        error?.message,
        error?.original?.message,
        error?.parent?.message,
        error?.sql
    ].filter(Boolean).join(' ');

    if (errorText.includes('conversations_one_active_per_job')) {
        console.error(
            '[chat] ERROR: DB_SYNC_ALTER could not create the partial unique index '
            + 'conversations_one_active_per_job. Resolve duplicate ACTIVE conversations or the '
            + 'reported PostgreSQL error before starting the application.'
        );
    }
    if (errorText.includes('conversations_job_acceptance_cycle_unique')) {
        console.error(
            '[chat] ERROR: DB_SYNC_ALTER could not create the mandatory unique constraint/index '
            + 'conversations_job_acceptance_cycle_unique. The application will not start without it.'
        );
    }
    if (errorText.includes('job_arrival_requests_one_pending_per_cycle')) {
        console.error(
            '[matchmaking] ERROR: DB_SYNC_ALTER could not create the mandatory partial unique index '
            + 'job_arrival_requests_one_pending_per_cycle. Resolve any duplicate PENDING arrival '
            + 'requests for the same job/cycle before starting the application.'
        );
    }
    if (errorText.includes('job_quotes_one_draft_per_cycle')
        || errorText.includes('job_quotes_job_cycle_version_unique')
        || errorText.includes('job_quote_items_quote_sort_unique')) {
        console.error(
            '[matchmaking] ERROR: DB_SYNC_ALTER could not create the mandatory Job Quote indexes. '
            + 'Resolve duplicate quote drafts or versions for the same job/cycle before restarting.'
        );
    }
    if (errorText.includes('job_cancellations_one_active_per_cycle')
        || errorText.includes('transactions_idempotency_key_unique')) {
        console.error(
            '[matchmaking] ERROR: DB_SYNC_ALTER could not create the mandatory cancellation indexes. '
            + 'Resolve duplicate active cancellations or transaction idempotency keys before restarting.'
        );
    }
    if (errorText.includes('transactions_one_successful_remaining_payment_per_quote')
        || errorText.includes('e_contracts_job_cycle_unique')
        || errorText.includes('e_contracts_quote_unique')
        || errorText.includes('e_contracts_contract_number_unique')) {
        console.error(
            '[fintech] ERROR: DB_SYNC_ALTER could not create the required remaining-payment '
            + 'or service-contract indexes. Resolve duplicate rows before restarting.'
        );
    }
};

const verifyArrivalRequestIndexes = async () => {
    const [indexes] = await db.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename = 'Job_Arrival_Requests'
          AND indexname = 'job_arrival_requests_one_pending_per_cycle'
    `);
    const indexDefinition = String(indexes[0]?.indexdef || '');
    if (!indexDefinition.includes('UNIQUE')
        || !indexDefinition.includes('job_id')
        || !indexDefinition.includes('acceptance_cycle')
        || !indexDefinition.includes('WHERE')
        || !indexDefinition.includes('PENDING')) {
        throw new Error(
            'Required partial unique index job_arrival_requests_one_pending_per_cycle is missing. '
            + 'Run once with DB_SYNC_ALTER=true after backing up the database.'
        );
    }
    console.log('Arrival request indexes verified successfully.');
};

const verifyJobQuoteIndexes = async () => {
    const [indexes] = await db.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename = 'Job_Quotes'
          AND indexname IN (
            'job_quotes_job_cycle_version_unique',
            'job_quotes_one_draft_per_cycle'
          )
    `);
    const byName = new Map(indexes.map((index) => [index.indexname, index.indexdef]));
    const versionIndex = String(byName.get('job_quotes_job_cycle_version_unique') || '');
    const draftIndex = String(byName.get('job_quotes_one_draft_per_cycle') || '');
    const [itemIndexes] = await db.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename = 'Job_Quote_Items'
          AND indexname = 'job_quote_items_quote_sort_unique'
    `);
    const itemSortIndex = String(itemIndexes[0]?.indexdef || '');

    if (!versionIndex.includes('UNIQUE')
        || !versionIndex.includes('job_id')
        || !versionIndex.includes('acceptance_cycle')
        || !versionIndex.includes('version')) {
        throw new Error(
            'Required unique index job_quotes_job_cycle_version_unique is missing. '
            + 'Run once with DB_SYNC_ALTER=true after backing up the database.'
        );
    }
    if (!draftIndex.includes('UNIQUE')
        || !draftIndex.includes('job_id')
        || !draftIndex.includes('acceptance_cycle')
        || !draftIndex.includes('WHERE')
        || !draftIndex.includes('DRAFT')) {
        throw new Error(
            'Required partial unique index job_quotes_one_draft_per_cycle is missing. '
            + 'Run once with DB_SYNC_ALTER=true after backing up the database.'
        );
    }
    if (!itemSortIndex.includes('UNIQUE')
        || !itemSortIndex.includes('quote_id')
        || !itemSortIndex.includes('sort_order')) {
        throw new Error(
            'Required unique index job_quote_items_quote_sort_unique is missing. '
            + 'Run once with DB_SYNC_ALTER=true after backing up the database.'
        );
    }
    console.log('Job Quote indexes verified successfully.');
};

const verifyCancellationIndexes = async () => {
    const [cancellationIndexes] = await db.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename = 'Job_Cancellations'
          AND indexname = 'job_cancellations_one_active_per_cycle'
    `);
    const cancellationIndex = String(cancellationIndexes[0]?.indexdef || '');
    if (!cancellationIndex.includes('UNIQUE')
        || !cancellationIndex.includes('job_id')
        || !cancellationIndex.includes('acceptance_cycle')
        || !cancellationIndex.includes('WHERE')
        || !cancellationIndex.includes('AWAITING_COUNTERPARTY')
        || !cancellationIndex.includes('REVIEW_REQUIRED')) {
        throw new Error(
            'Required partial unique index job_cancellations_one_active_per_cycle is missing. '
            + 'Run once with DB_SYNC_ALTER=true after backing up the database.'
        );
    }

    const [transactionIndexes] = await db.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename = 'Transactions'
          AND indexname = 'transactions_idempotency_key_unique'
    `);
    const idempotencyIndex = String(transactionIndexes[0]?.indexdef || '');
    if (!idempotencyIndex.includes('UNIQUE')
        || !idempotencyIndex.includes('idempotency_key')
        || !idempotencyIndex.includes('WHERE')) {
        throw new Error(
            'Required unique index transactions_idempotency_key_unique is missing. '
            + 'Run once with DB_SYNC_ALTER=true after backing up the database.'
        );
    }
    console.log('Cancellation indexes verified successfully.');
};

const verifyQuotePaymentIndexes = async () => {
    const [transactionIndexes] = await db.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename = 'Transactions'
          AND indexname = 'transactions_one_successful_remaining_payment_per_quote'
    `);
    const paymentIndex = String(transactionIndexes[0]?.indexdef || '');
    if (!paymentIndex.includes('UNIQUE')
        || !paymentIndex.includes('job_id')
        || !paymentIndex.includes('acceptance_cycle')
        || !paymentIndex.includes('quote_id')
        || !paymentIndex.includes('SERVICE_REMAINING_PAYMENT')
        || !paymentIndex.includes('SUCCESS')) {
        throw new Error(
            'Required unique index transactions_one_successful_remaining_payment_per_quote '
            + 'is missing. Run once with DB_SYNC_ALTER=true after backing up the database.'
        );
    }

    const [contractIndexes] = await db.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename = 'E_Contracts'
          AND indexname IN (
            'e_contracts_job_cycle_unique',
            'e_contracts_quote_unique',
            'e_contracts_contract_number_unique'
          )
    `);
    const byName = new Map(contractIndexes.map((index) => [index.indexname, index.indexdef]));
    const requiredContractIndexes = [
        ['e_contracts_job_cycle_unique', ['job_id', 'acceptance_cycle']],
        ['e_contracts_quote_unique', ['quote_id']],
        ['e_contracts_contract_number_unique', ['contract_number']]
    ];
    for (const [name, fields] of requiredContractIndexes) {
        const definition = String(byName.get(name) || '');
        if (!definition.includes('UNIQUE')
            || fields.some((field) => !definition.includes(field))) {
            throw new Error(
                `Required service-contract unique index ${name} is missing. `
                + 'Run once with DB_SYNC_ALTER=true after backing up the database.'
            );
        }
    }
    console.log('Quote payment and service-contract indexes verified successfully.');
};

User.hasMany(Review, { foreignKey: 'reviewer_id' });
Review.belongsTo(User, { as: 'Reviewer', foreignKey: 'reviewer_id' });

User.hasMany(Review, { foreignKey: 'reviewee_id' });
Review.belongsTo(User, { as: 'Reviewee', foreignKey: 'reviewee_id' });


const initDatabase = async () => {
    try {
        await db.authenticate();
        console.log('Connection to PostgreSQL has been established successfully.');
        const shouldAlter = String(process.env.DB_SYNC_ALTER || '').toLowerCase() === 'true';
        if (shouldAlter) {
            console.warn('DB_SYNC_ALTER=true: synchronizing model changes with alter mode. Disable it after this run.');
            try {
                await db.sync({ alter: true });
            } catch (error) {
                reportIndexSyncFailure(error);
                throw error;
            }
            console.log('All models were synchronized successfully with alter mode.');
        } else {
            console.log('Automatic schema alteration is disabled.');
        }
        await verifyChatIndexes();
        await verifyArrivalRequestIndexes();
        await verifyJobQuoteIndexes();
        await verifyCancellationIndexes();
        await verifyQuotePaymentIndexes();
    } catch (error) {
        console.error('Unable to connect to the database:', error);
        throw error;
    }
};

export { db, initDatabase };
