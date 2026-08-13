import { Op } from 'sequelize';
import Job from '../models/Job.model.js';
import Bid from '../models/Bid.model.js';
import Service from '../models/Service.model.js';
import HandymanService from '../models/HandymanService.model.js';
import User from '../../identity/models/User.model.js';
import HandymanProfile from '../../identity/models/HandymanProfile.model.js';
import Review from '../../dispute/models/Review.model.js';
import {
    canonicalReviewWhere,
    getRatingSummaries,
    getRatingSummary
} from '../../dispute/services/Rating.service.js';

const MAX_COMPARE_BIDS = 3;
const MAX_CATEGORY_JOBS_FOR_FULL_SCORE = 20;
const MAX_TOTAL_JOBS_FOR_FULL_SCORE = 50;
const MATCH_SCORE_WEIGHTS = {
    price: 30,
    reputation: 25,
    categoryExperience: 20,
    totalExperience: 10,
    kyc: 5,
    eta: 5,
    completionTime: 5
};

const roundToTwoDecimals = (value) => Number(Number(value || 0).toFixed(2));

const getMinutesUntilEta = (eta, now = new Date()) => {
    if (!eta) return null;
    const etaDate = new Date(eta);
    if (Number.isNaN(etaDate.getTime())) return null;

    const minutes = Math.ceil((etaDate.getTime() - now.getTime()) / 60000);
    return Math.max(minutes, 1);
};

const getKycScore = ({ kycStatus, handymanLevel }) => {
    const verifiedScore = kycStatus === 'VERIFIED' ? 3 : 0;
    const levelScoreMap = {
        C0: 0,
        C1: 0.75,
        C2: 1.5,
        C3: 2
    };
    return verifiedScore + (levelScoreMap[handymanLevel] || 0);
};

const calculateMatchScore = ({
    proposedPrice,
    lowestPrice,
    averageRating,
    completedSameServiceJobs,
    totalJobsCompleted,
    kycStatus,
    handymanLevel,
    eta,
    shortestEtaMinutes,
    estimatedDurationHours,
    shortestDurationHours,
    now
}) => {
    const price = Number(proposedPrice);
    const minPrice = Number(lowestPrice);
    const score = Number(averageRating || 0);
    const sameServiceJobs = Number(completedSameServiceJobs || 0);
    const totalJobs = Number(totalJobsCompleted || 0);
    const duration = Number(estimatedDurationHours);
    const minDuration = Number(shortestDurationHours);
    const etaMinutes = getMinutesUntilEta(eta, now);

    const priceScore = price > 0 && minPrice > 0 ? MATCH_SCORE_WEIGHTS.price * (minPrice / price) : 0;
    const reputationScore = MATCH_SCORE_WEIGHTS.reputation * (Math.min(score, 5) / 5);
    const categoryExperienceScore = MATCH_SCORE_WEIGHTS.categoryExperience
        * (Math.min(sameServiceJobs, MAX_CATEGORY_JOBS_FOR_FULL_SCORE) / MAX_CATEGORY_JOBS_FOR_FULL_SCORE);
    const totalExperienceScore = MATCH_SCORE_WEIGHTS.totalExperience
        * (Math.min(totalJobs, MAX_TOTAL_JOBS_FOR_FULL_SCORE) / MAX_TOTAL_JOBS_FOR_FULL_SCORE);
    const kycScore = getKycScore({ kycStatus, handymanLevel });
    const etaScore = etaMinutes && shortestEtaMinutes
        ? MATCH_SCORE_WEIGHTS.eta * (shortestEtaMinutes / etaMinutes)
        : 0;
    const completionTimeScore = duration > 0 && minDuration > 0
        ? MATCH_SCORE_WEIGHTS.completionTime * (minDuration / duration)
        : 0;

    return {
        price_score: roundToTwoDecimals(priceScore),
        reputation_score: roundToTwoDecimals(reputationScore),
        category_experience_score: roundToTwoDecimals(categoryExperienceScore),
        expertise_score: roundToTwoDecimals(categoryExperienceScore),
        total_experience_score: roundToTwoDecimals(totalExperienceScore),
        kyc_score: roundToTwoDecimals(kycScore),
        eta_score: roundToTwoDecimals(etaScore),
        completion_time_score: roundToTwoDecimals(completionTimeScore),
        total_match_score: roundToTwoDecimals(
            priceScore
            + reputationScore
            + categoryExperienceScore
            + totalExperienceScore
            + kycScore
            + etaScore
            + completionTimeScore
        ),
        weights: MATCH_SCORE_WEIGHTS
    };
};

const mapBidForMatchResponse = async (bid, benchmarks) => {
    const plainBid = bid.toJSON ? bid.toJSON() : bid;
    const handyman = plainBid.User || {};
    const profile = handyman.Handyman_Profile || {};
    const completedSameServiceJobs = benchmarks.completedJobs.get(plainBid.handyman_id) || 0;
    const ratingSummary = benchmarks.ratings.get(plainBid.handyman_id);
    const rankingRating = ratingSummary?.average_rating || null;
    const score = calculateMatchScore({
        proposedPrice: plainBid.proposed_price,
        lowestPrice: benchmarks.lowestPrice,
        averageRating: rankingRating,
        completedSameServiceJobs,
        totalJobsCompleted: profile.total_jobs_completed,
        kycStatus: handyman.kyc_status,
        handymanLevel: profile.handyman_level,
        eta: plainBid.eta,
        shortestEtaMinutes: benchmarks.shortestEtaMinutes,
        estimatedDurationHours: plainBid.estimated_duration_hours,
        shortestDurationHours: benchmarks.shortestDurationHours,
        now: benchmarks.now
    });

    return {
        bid_id: plainBid.id,
        handyman_id: plainBid.handyman_id,
        proposed_price: plainBid.proposed_price,
        eta: plainBid.eta,
        estimated_duration_hours: plainBid.estimated_duration_hours,
        bid_message: plainBid.message,
        bid_status: plainBid.status,
        handyman: {
            id: handyman.id,
            full_name: handyman.full_name,
            role: handyman.role,
            avatar_url: handyman.avatar_url,
            kyc_status: handyman.kyc_status,
            rating_summary: ratingSummary,
            total_jobs_completed: profile.total_jobs_completed || 0,
            handyman_level: profile.handyman_level || null
        },
        completed_same_service_jobs: completedSameServiceJobs,
        match_score: score.total_match_score,
        match_score_details: score,
        isBestChoice: false
    };
};

const buildMatchResultsForBids = async (bids, serviceId) => {
    if (!bids || bids.length === 0) {
        return [];
    }

    const now = new Date();
    const etaMinutesList = bids
        .map((bid) => getMinutesUntilEta(bid.eta, now))
        .filter((minutes) => minutes !== null);
    const durationList = bids
        .map((bid) => Number(bid.estimated_duration_hours))
        .filter((duration) => duration > 0);
    const handymanIds = [...new Set(bids.map((bid) => bid.handyman_id))];
    const [ratings, completedRows] = await Promise.all([
        getRatingSummaries(handymanIds.map((id) => ({ id, role: 'HANDYMAN' }))),
        Job.findAll({
            where: { selected_handyman_id: { [Op.in]: handymanIds }, service_id: serviceId, current_status: 'CLOSED' },
            attributes: ['selected_handyman_id'],
            raw: true
        })
    ]);
    const completedJobs = new Map(handymanIds.map((id) => [id, 0]));
    completedRows.forEach((entry) => completedJobs.set(
        entry.selected_handyman_id,
        (completedJobs.get(entry.selected_handyman_id) || 0) + 1
    ));
    const benchmarks = {
        now,
        lowestPrice: Math.min(...bids.map((bid) => Number(bid.proposed_price))),
        shortestEtaMinutes: etaMinutesList.length > 0 ? Math.min(...etaMinutesList) : null,
        shortestDurationHours: durationList.length > 0 ? Math.min(...durationList) : null,
        ratings,
        completedJobs
    };

    const results = await Promise.all(
        bids.map((bid) => mapBidForMatchResponse(bid, benchmarks))
    );

    results.sort((a, b) => b.match_score - a.match_score);
    return results.map((item, index) => ({
        ...item,
        isBestChoice: index === 0
    }));
};

const getPublicHandymanProfileService = async (customerId, jobId, handymanId) => {
    try {
        const job = await Job.findByPk(jobId, {
            attributes: ['id', 'customer_id', 'service_id', 'current_status']
        });

        if (!job) {
            return { EM: "Job not found.", EC: 404, DT: "" };
        }

        if (job.customer_id !== customerId) {
            return { EM: "You do not have permission to view handyman profiles for this job.", EC: 403, DT: "" };
        }

        const activeBid = await Bid.findOne({
            where: {
                job_id: jobId,
                handyman_id: handymanId,
                status: { [Op.ne]: 'WITHDRAWN' }
            },
            attributes: ['id']
        });

        if (!activeBid) {
            return { EM: "This handyman does not have an active bid on this job.", EC: 404, DT: "" };
        }

        const handyman = await User.findOne({
            where: { id: handymanId, role: 'HANDYMAN' },
            attributes: ['id', 'full_name', 'role', 'avatar_url', 'kyc_status'],
            include: [
                {
                    model: HandymanProfile,
                    attributes: ['total_jobs_completed', 'handyman_level', 'bio'],
                    required: false
                },
                {
                    model: HandymanService,
                    as: 'Handyman_Services',
                    attributes: ['id', 'service_id'],
                    include: [
                        { model: Service, attributes: ['id', 'name', 'service_code', 'icon_url'] }
                    ]
                }
            ]
        });

        if (!handyman) {
            return { EM: "Handyman profile not found.", EC: 404, DT: "" };
        }

        const reviews = await Review.findAll({
            where: canonicalReviewWhere({ reviewee_id: handymanId }),
            attributes: ['id', 'rating_stars', 'comment', 'is_job_successful', 'createdAt'],
            include: [
                {
                    model: Job,
                    attributes: ['id', 'service_id'],
                    include: [{ model: Service, attributes: ['id', 'name', 'service_code'] }]
                },
                {
                    model: User,
                    as: 'Reviewer',
                    attributes: ['id', 'full_name', 'avatar_url']
                }
            ],
            order: [['createdAt', 'DESC'], ['id', 'DESC']],
            limit: 50
        });

        const sortedReviews = reviews
            .map((review) => {
                const plainReview = review.toJSON();
                return {
                    id: plainReview.id,
                    rating_stars: plainReview.rating_stars,
                    comment: plainReview.comment,
                    is_job_successful: plainReview.is_job_successful,
                    created_at: plainReview.createdAt,
                    is_same_service_as_current_job: plainReview.Job?.service_id === job.service_id,
                    service: plainReview.Job?.Service || null,
                    reviewer: plainReview.Reviewer || null
                };
            })
            .sort((a, b) => {
                if (a.is_same_service_as_current_job === b.is_same_service_as_current_job) {
                    return new Date(b.created_at) - new Date(a.created_at);
                }
                return a.is_same_service_as_current_job ? -1 : 1;
            });

        const successfulReviewsCount = sortedReviews.filter((review) => review.is_job_successful).length;
        const successRate = sortedReviews.length > 0
            ? roundToTwoDecimals((successfulReviewsCount / sortedReviews.length) * 100)
            : 0;

        const ratingSummary = await getRatingSummary(handymanId, 'HANDYMAN');
        const plainHandyman = handyman.toJSON();
        const profile = plainHandyman.Handyman_Profile || {};

        return {
            EM: "Public handyman profile retrieved successfully.",
            EC: 0,
            DT: {
                id: plainHandyman.id,
                full_name: plainHandyman.full_name,
                role: plainHandyman.role,
                avatar_url: plainHandyman.avatar_url,
                kyc_status: plainHandyman.kyc_status,
                rating_summary: ratingSummary,
                total_jobs_completed: profile.total_jobs_completed || 0,
                success_rate: successRate,
                successful_reviews_count: successfulReviewsCount,
                handyman_level: profile.handyman_level || null,
                about_me: profile.bio || "",
                expertise_and_skills: plainHandyman.Handyman_Services || [],
                reviews: sortedReviews
            }
        };
    } catch (error) {
        console.log(">>> Error in getPublicHandymanProfileService: ", error);
        return { EM: "Internal server error while retrieving public handyman profile.", EC: 500, DT: "" };
    }
};

// Xử lý so sánh các bid của một công việc cụ thể. Nó nhận vào customerId, job_id và một mảng bid_ids để so sánh.
const compareBidsService = async (customerId, { job_id, bid_ids }) => {
    try {
        if (!job_id) {
            return { EM: "job_id is required.", EC: 400, DT: "" };
        }

        if (!Array.isArray(bid_ids) || bid_ids.length === 0) {
            return { EM: "bid_ids must be a non-empty array.", EC: 400, DT: "" };
        }

        if (bid_ids.length > MAX_COMPARE_BIDS) {
            return { EM: `You can compare up to ${MAX_COMPARE_BIDS} bids at a time.`, EC: 400, DT: "" };
        }

        const uniqueBidIds = [...new Set(bid_ids)];
        if (uniqueBidIds.length !== bid_ids.length) {
            return { EM: "bid_ids must not contain duplicated values.", EC: 400, DT: "" };
        }

        const job = await Job.findByPk(job_id, {
            attributes: ['id', 'customer_id', 'service_id', 'current_status']
        });

        if (!job) {
            return { EM: "Job not found.", EC: 404, DT: "" };
        }

        if (job.customer_id !== customerId) {
            return { EM: "You do not have permission to compare bids for this job.", EC: 403, DT: "" };
        }

        if (job.current_status !== 'BIDDING') {
            return { EM: "This job is not in the bidding stage.", EC: 400, DT: "" };
        }

        const bids = await Bid.findAll({
            where: {
                id: { [Op.in]: uniqueBidIds },
                job_id,
                status: 'PENDING'
            },
            include: [
                {
                    model: User,
                    attributes: ['id', 'full_name', 'role', 'avatar_url', 'kyc_status'],
                    include: [
                        {
                            model: HandymanProfile,
                            attributes: ['total_jobs_completed', 'handyman_level'],
                            required: false
                        }
                    ]
                }
            ]
        });

        if (bids.length !== uniqueBidIds.length) {
            return { EM: "One or more bids were not found or are no longer available.", EC: 404, DT: "" };
        }

        const comparison = await buildMatchResultsForBids(bids, job.service_id);

        return {
            EM: "Bids compared successfully.",
            EC: 0,
            DT: comparison
        };
    } catch (error) {
        console.log(">>> Error in compareBidsService: ", error);
        return { EM: "Internal server error while comparing bids.", EC: 500, DT: "" };
    }
};

export {
    buildMatchResultsForBids,
    getPublicHandymanProfileService,
    compareBidsService
};
