import { DataTypes } from 'sequelize';
import db from '../../../core/database/connection.js';

const Job = db.define('Job', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    issue_description: { type: DataTypes.TEXT, allowNull: false },
    estimated_budget_min: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    estimated_budget_max: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    final_agreed_price: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    deposit_amount: { type: DataTypes.DECIMAL(15, 2), allowNull: true },
    deposit_status: {
        type: DataTypes.ENUM('HELD', 'REFUNDED'),
        allowNull: true
    },
    deposit_paid_at: { type: DataTypes.DATE, allowNull: true },
    accepted_at: { type: DataTypes.DATE, allowNull: true },
    en_route_at: { type: DataTypes.DATE, allowNull: true },
    en_route_gps_lat: { type: DataTypes.DECIMAL(10, 8), allowNull: true },
    en_route_gps_long: { type: DataTypes.DECIMAL(11, 8), allowNull: true },
    en_route_gps_accuracy_meters: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    en_route_distance_meters: { type: DataTypes.INTEGER, allowNull: true },
    en_route_estimated_arrival_minutes: { type: DataTypes.INTEGER, allowNull: true },
    arrived_at: { type: DataTypes.DATE, allowNull: true },
    arrival_confirmed_by_user_id: { type: DataTypes.UUID, allowNull: true },
    cancelled_at: { type: DataTypes.DATE, allowNull: true },
    contact_unlocked_at: { type: DataTypes.DATE, allowNull: true },
    acceptance_cycle: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        validate: { min: 0 }
    },
    selected_bid_id: { type: DataTypes.UUID, allowNull: true },
    deposit_transaction_id: { type: DataTypes.UUID, allowNull: true },
    province_code: { type: DataTypes.STRING(2), allowNull: true }, 
    ward_code: { type: DataTypes.STRING(6), allowNull: true },
    detail_address: { type: DataTypes.TEXT, allowNull: true },
    service_address: { type: DataTypes.TEXT, allowNull: false }, 
    gps_lat: { type: DataTypes.DECIMAL(10, 8) },
    gps_long: { type: DataTypes.DECIMAL(11, 8) },
    location_source: {
        type: DataTypes.ENUM(
            'CURRENT_GPS',
            'GEOCODED_ADDRESS',
            'PROFILE_ADDRESS',
            'MANUAL_MAP_PIN',
            'ADDRESS_ONLY'
        ),
        allowNull: true
    },
    location_confirmed: { type: DataTypes.BOOLEAN, allowNull: true },
    location_confirmed_at: { type: DataTypes.DATE, allowNull: true },
    scheduled_at: { type: DataTypes.DATE, allowNull: true },
    images: { type: DataTypes.JSON, defaultValue: [] },
    current_status: { 
        type: DataTypes.ENUM('POSTED', 'BIDDING', 'PENDING_DEPOSIT', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS', 'WARRANTY', 'CLOSED', 'CANCELLED'),
        defaultValue: 'POSTED' 
    }
}, { timestamps: true });

export default Job;
