import { DataTypes } from 'sequelize';
import db from '../../../core/database/connection.js';

const EContract = db.define('E_Contract', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
    },
    job_id: { type: DataTypes.UUID, allowNull: false },
    acceptance_cycle: {
        type: DataTypes.INTEGER,
        allowNull: false,
        validate: { min: 1 }
    },
    quote_id: { type: DataTypes.UUID, allowNull: false },
    customer_id: { type: DataTypes.UUID, allowNull: false },
    handyman_id: { type: DataTypes.UUID, allowNull: false },
    selected_bid_id: { type: DataTypes.UUID, allowNull: false },
    remaining_payment_transaction_id: { type: DataTypes.UUID, allowNull: true },
    contract_number: { type: DataTypes.STRING(40), allowNull: false },
    status: {
        type: DataTypes.ENUM('DRAFT', 'ACTIVE', 'CANCELLED', 'COMPLETED'),
        allowNull: false,
        defaultValue: 'ACTIVE'
    },
    currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'VND' },
    subtotal_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
    discount_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
    quote_total_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
    deposit_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
    remaining_payment_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
    full_escrow_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
    problem_summary: { type: DataTypes.TEXT, allowNull: false },
    inspection_notes: { type: DataTypes.TEXT, allowNull: true },
    recommended_solution: { type: DataTypes.TEXT, allowNull: false },
    estimated_duration_minutes: { type: DataTypes.INTEGER, allowNull: false },
    warranty_days: { type: DataTypes.INTEGER, allowNull: false },
    bid_reference_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: false },
    variance_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
    variance_percent: { type: DataTypes.DECIMAL(20, 4), allowNull: true },
    variance_reason: { type: DataTypes.STRING(80), allowNull: true },
    variance_reason_text: { type: DataTypes.TEXT, allowNull: true },
    quote_items_snapshot: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    customer_name_snapshot: { type: DataTypes.STRING(100), allowNull: false },
    handyman_name_snapshot: { type: DataTypes.STRING(100), allowNull: false },
    service_address_snapshot: { type: DataTypes.TEXT, allowNull: false },
    customer_accepted_at: { type: DataTypes.DATE, allowNull: false },
    payment_completed_at: { type: DataTypes.DATE, allowNull: false },
    effective_at: { type: DataTypes.DATE, allowNull: false },
    pdf_url: { type: DataTypes.TEXT, allowNull: true },
    customer_otp_signature: { type: DataTypes.STRING(10), allowNull: true },
    agreed_price: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    generated_at: { type: DataTypes.DATE, allowNull: true }
}, {
    timestamps: true,
    indexes: [
        {
            name: 'e_contracts_job_cycle_unique',
            unique: true,
            fields: ['job_id', 'acceptance_cycle']
        },
        {
            name: 'e_contracts_quote_unique',
            unique: true,
            fields: ['quote_id']
        },
        {
            name: 'e_contracts_contract_number_unique',
            unique: true,
            fields: ['contract_number']
        },
        { name: 'e_contracts_participants', fields: ['customer_id', 'handyman_id'] }
    ]
});

export default EContract;
