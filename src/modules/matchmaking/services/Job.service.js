import { Op } from 'sequelize';
import Job from '../models/Job.model.js';
import Service from '../models/Service.model.js';
import User from '../../identity/models/User.model.js';
import UserAddress from '../../identity/models/UserAddress.model.js';
import HandymanProfile from '../../identity/models/HandymanProfile.model.js';
import JobStatusHistory from '../models/JobStatusHistory.model.js';
import Bid from '../models/Bid.model.js';
import Province from '../models/Province.model.js';
import Ward from '../models/Ward.model.js';
import db from '../../../core/database/connection.js';
import { buildMatchResultsForBids } from './CustomerHandymanSelection.service.js';
import { calculateDistanceKm } from '../utils/location.util.js';

const getServicesCategoryService = async () => {
    try {
        const services = await Service.findAll({
            where: { is_active: true },
            order: [['name', 'ASC']]
        });
        return {
            EM: "Services list retrieved successfully.",
            EC: 0,
            DT: services
        };
    } catch (error) {
        console.log(">>> Error in getServicesCategoryService: ", error);
        return {
            EM: "Internal server error while retrieving services.",
            EC: 500,
            DT: []
        };
    }
};

const getJobDetailsByIdService = async (jobId, requestingUser, { current_lat = null, current_long = null } = {}) => {
    try {
        // Build bid include based on the requesting user's role
        let bidInclude;

        if (requestingUser?.role === 'HANDYMAN') {
            // Handyman sees only their own bid (no peeking at competitors)
            bidInclude = {
                model: Bid,
                attributes: ['id', 'proposed_price', 'message', 'eta', 'estimated_duration_hours', 'status', 'createdAt', 'updatedAt'],
                where: {
                    handyman_id: requestingUser.id,
                    status: { [Op.ne]: 'WITHDRAWN' }
                },
                required: false
            };
        } else if (requestingUser?.role === 'CUSTOMER') {
            // Customer sees all active bids with handyman profile info
            bidInclude = {
                model: Bid,
                attributes: ['id', 'proposed_price', 'message', 'eta', 'estimated_duration_hours', 'status', 'handyman_id', 'createdAt', 'updatedAt'],
                where: { status: { [Op.ne]: 'WITHDRAWN' } },
                required: false,
                include: [
                    {
                        model: User,
                        attributes: ['id', 'full_name', 'avatar_url', 'role', 'kyc_status'],
                        include: [
                            {
                                model: HandymanProfile,
                                attributes: ['bayesian_score', 'total_jobs_completed', 'handyman_level'],
                                required: false
                            }
                        ]
                    }
                ]
            };
        } else {
            // ADMIN sees everything
            bidInclude = {
                model: Bid,
                attributes: ['id', 'proposed_price', 'message', 'eta', 'estimated_duration_hours', 'status', 'handyman_id', 'createdAt'],
                where: { status: { [Op.ne]: 'WITHDRAWN' } },
                required: false
            };
        }

        const job = await Job.findOne({
            where: { id: jobId },
            include: [
                {
                    model: Service,
                    attributes: ['id', 'name', 'service_code', 'icon_url']
                },
                {
                    model: User,
                    as: 'Customer',
                    attributes: [
                        'id', 'full_name', 'avatar_url', 'phone_number', 'kyc_status',
                        [
                            db.literal(`(SELECT COALESCE(ROUND(AVG(r.rating_stars::numeric), 1), 0) FROM "Reviews" r WHERE r.reviewee_id = "Customer"."id")`),
                            'avg_rating'
                        ]
                    ]
                },
                {
                    model: User,
                    as: 'SelectedHandyman',
                    attributes: ['id', 'full_name', 'avatar_url', 'phone_number'],
                    include: [
                        {
                            model: UserAddress,
                            attributes: [
                                'id', 'province_code', 'ward_code',
                                'detail_address', 'full_address', 'is_default'
                            ],
                            required: false
                        }
                    ]
                },
                {
                    model: Province,
                    attributes: ['province_code', 'name', 'short_name'],
                    required: false
                },
                {
                    model: Ward,
                    attributes: ['ward_code', 'name'],
                    required: false
                },
                {
                    model: JobStatusHistory,
                    include: [
                        {
                            model: User,
                            attributes: ['id', 'full_name', 'role']
                        }
                    ]
                },
                bidInclude
            ],
            order: [
                [JobStatusHistory, 'createdAt', 'DESC']
            ]
        });

        if (!job) {
            return { EM: "Job not found.", EC: 404, DT: "" };
        }

        let responseData = job.toJSON();
        const isAdmin = requestingUser?.role === 'ADMIN';
        const isOwnerCustomer = requestingUser?.role === 'CUSTOMER'
            && responseData.customer_id === requestingUser.id;
        const ownBid = requestingUser?.role === 'HANDYMAN'
            ? responseData.Bids?.[0]
            : null;
        const isOpenForBidding = ['POSTED', 'BIDDING'].includes(responseData.current_status);

        if (requestingUser?.role === 'CUSTOMER' && !isOwnerCustomer) {
            return { EM: "You do not have permission to view this job.", EC: 403, DT: "" };
        }

        if (
            requestingUser?.role === 'HANDYMAN'
            && !isOpenForBidding
            && !ownBid
        ) {
            return { EM: "You do not have permission to view this job.", EC: 403, DT: "" };
        }

        if (requestingUser?.role === 'CUSTOMER' && responseData.Bids?.length > 0) {
            const pendingBids = job.Bids.filter((bid) => bid.status === 'PENDING');
            const matchResults = await buildMatchResultsForBids(pendingBids, responseData.service_id);
            const matchResultByBidId = new Map(matchResults.map((item) => [item.bid_id, item]));

            responseData.Bids = responseData.Bids
                .map((bid) => {
                    const matchResult = matchResultByBidId.get(bid.id);
                    if (!matchResult) return bid;

                    return {
                        ...bid,
                        completed_same_service_jobs: matchResult.completed_same_service_jobs,
                        match_score: matchResult.match_score,
                        match_score_details: matchResult.match_score_details,
                        isBestChoice: matchResult.isBestChoice
                    };
                })
                .sort((a, b) => {
                    if (a.isBestChoice) return -1;
                    if (b.isBestChoice) return 1;
                    return Number(b.match_score || 0) - Number(a.match_score || 0);
                });
        }

        if (requestingUser?.role === 'HANDYMAN') {
            // Active bid count so handyman knows competition level
            const activeBidCount = await Bid.count({
                where: { job_id: jobId, status: 'PENDING' }
            });
            responseData.active_bid_count = activeBidCount;

            // Distance from handyman's current location to job site
            if (current_lat != null && current_long != null && responseData.gps_lat != null && responseData.gps_long != null) {
                responseData.distance_km = calculateDistanceKm(
                    parseFloat(current_lat),
                    parseFloat(current_long),
                    parseFloat(responseData.gps_lat),
                    parseFloat(responseData.gps_long)
                );
            } else {
                responseData.distance_km = null;
            }
        }

        const contactUnlockedStatuses = [
            'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'QUOTE_PENDING',
            'IN_PROGRESS', 'WARRANTY', 'CLOSED'
        ];
        const contactIsUnlocked = Boolean(responseData.contact_unlocked_at)
            && contactUnlockedStatuses.includes(responseData.current_status);
        const isSelectedHandyman = requestingUser?.role === 'HANDYMAN'
            && responseData.selected_handyman_id === requestingUser.id;
        const canSeeJobLocation = isAdmin || isOwnerCustomer
            || (isSelectedHandyman && contactIsUnlocked);
        const canSeeHandymanRawGps = isAdmin || isSelectedHandyman;
        const canSeeHandymanLocationMetadata = isAdmin || isOwnerCustomer || isSelectedHandyman;
        const canSeeCustomerContact = isAdmin || isOwnerCustomer
            || (isSelectedHandyman && contactIsUnlocked);
        const canSeeHandymanContact = isAdmin || isSelectedHandyman
            || (isOwnerCustomer && contactIsUnlocked);

        if (!canSeeJobLocation) {
            responseData.detail_address = null;
            responseData.gps_lat = null;
            responseData.gps_long = null;
            responseData.location_source = null;
            responseData.location_confirmed = null;
            responseData.location_confirmed_at = null;
            const statusHistories = responseData.Job_Status_Histories
                || responseData.JobStatusHistories
                || [];
            statusHistories.forEach((history) => {
                history.trigger_gps_lat = null;
                history.trigger_gps_long = null;
            });
            responseData.service_address = [
                responseData.Ward?.name,
                responseData.Province?.name
            ].filter(Boolean).join(', ');
        }

        if (!canSeeHandymanRawGps) {
            responseData.en_route_gps_lat = null;
            responseData.en_route_gps_long = null;
            const statusHistories = responseData.Job_Status_Histories
                || responseData.JobStatusHistories
                || [];
            statusHistories.forEach((history) => {
                if (history.new_status === 'EN_ROUTE') {
                    history.trigger_gps_lat = null;
                    history.trigger_gps_long = null;
                }
            });
        }

        if (!canSeeHandymanLocationMetadata) {
            responseData.en_route_at = null;
            responseData.en_route_gps_accuracy_meters = null;
            responseData.en_route_distance_meters = null;
            responseData.en_route_estimated_arrival_minutes = null;
        }

        if (responseData.Customer && !canSeeCustomerContact) {
            responseData.Customer.phone_number = null;
        }

        if (responseData.SelectedHandyman && !canSeeHandymanContact) {
            responseData.SelectedHandyman.phone_number = null;
            responseData.SelectedHandyman.User_Addresses = [];
        }

        responseData.contact_is_unlocked_for_requester = contactIsUnlocked
            && (isAdmin || isOwnerCustomer || isSelectedHandyman);

        return {
            EM: "Job details retrieved successfully.",
            EC: 0,
            DT: responseData
        };
    } catch (error) {
        console.log(">>> Error in getJobDetailsByIdService: ", error);
        return {
            EM: "Internal server error while retrieving job details.",
            EC: 500,
            DT: ""
        };
    }
};

export { getServicesCategoryService, getJobDetailsByIdService };
