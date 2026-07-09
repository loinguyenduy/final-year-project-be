import { Op } from 'sequelize';
import Job from '../models/Job.model.js';
import Bid from '../models/Bid.model.js';
import JobStatusHistory from '../models/JobStatusHistory.model.js';
import Service from '../models/Service.model.js';
import Province from '../models/Province.model.js';
import Ward from '../models/Ward.model.js';
import db from '../../../core/database/connection.js';

const submitBidService = async (handymanId, jobId, bidData) => {
    const t = await db.transaction();
    try {
        const { proposed_price, message, eta, estimated_duration_hours } = bidData;

        if (!proposed_price || isNaN(Number(proposed_price)) || Number(proposed_price) <= 0) {
            await t.rollback();
            return { EM: "Proposed price must be a positive number.", EC: 400, DT: "" };
        }

        const job = await Job.findByPk(jobId, { transaction: t });
        if (!job) {
            await t.rollback();
            return { EM: "Job not found.", EC: 404, DT: "" };
        }

        if (!['POSTED', 'BIDDING'].includes(job.current_status)) {
            await t.rollback();
            return { EM: "This job is no longer accepting bids.", EC: 400, DT: "" };
        }

        // Prevent customer from bidding on their own job
        if (job.customer_id === handymanId) {
            await t.rollback();
            return { EM: "You cannot bid on your own job.", EC: 403, DT: "" };
        }

        const existingActiveBid = await Bid.findOne({
            where: {
                handyman_id: handymanId,
                job_id: jobId,
                status: { [Op.in]: ['PENDING', 'WON'] }
            },
            transaction: t
        });
        if (existingActiveBid) {
            await t.rollback();
            return { EM: "You have already submitted a bid for this job.", EC: 400, DT: "" };
        }

        const newBid = await Bid.create({
            handyman_id: handymanId,
            job_id: jobId,
            proposed_price,
            message: message || null,
            eta: eta ? new Date(eta) : null,
            estimated_duration_hours: estimated_duration_hours ? Number(estimated_duration_hours) : null,
            status: 'PENDING'
        }, { transaction: t });

        if (job.current_status === 'POSTED') {
            await job.update({ current_status: 'BIDDING' }, { transaction: t });
            await JobStatusHistory.create({
                job_id: jobId,
                changed_by_user_id: handymanId,
                old_status: 'POSTED',
                new_status: 'BIDDING'
            }, { transaction: t });
        }

        await t.commit();
        return { EM: "Bid submitted successfully.", EC: 0, DT: newBid };
    } catch (error) {
        await t.rollback();
        console.log(">>> Error in submitBidService: ", error);
        return { EM: "Internal server error while submitting bid.", EC: 500, DT: "" };
    }
};

const updateBidService = async (handymanId, jobId, bidId, bidData) => {
    try {
        const { proposed_price, message, eta, estimated_duration_hours } = bidData;

        const bid = await Bid.findOne({
            where: { id: bidId, handyman_id: handymanId, job_id: jobId }
        });
        if (!bid) {
            return { EM: "Bid not found or you do not have permission to update it.", EC: 404, DT: "" };
        }
        if (bid.status !== 'PENDING') {
            return { EM: "Cannot update a bid that is no longer pending.", EC: 400, DT: "" };
        }

        const job = await Job.findByPk(jobId);
        if (!job) {
            return { EM: "Job not found.", EC: 404, DT: "" };
        }
        if (!['POSTED', 'BIDDING'].includes(job.current_status)) {
            return { EM: "Cannot update bid — the job is no longer open for bidding.", EC: 400, DT: "" };
        }

        if (proposed_price !== undefined && (isNaN(Number(proposed_price)) || Number(proposed_price) <= 0)) {
            return { EM: "Proposed price must be a positive number.", EC: 400, DT: "" };
        }

        const updatePayload = {};
        if (proposed_price !== undefined) updatePayload.proposed_price = proposed_price;
        if (message !== undefined) updatePayload.message = message;
        if (eta !== undefined) updatePayload.eta = eta ? new Date(eta) : null;
        if (estimated_duration_hours !== undefined) updatePayload.estimated_duration_hours = estimated_duration_hours ? Number(estimated_duration_hours) : null;

        await bid.update(updatePayload);
        return { EM: "Bid updated successfully.", EC: 0, DT: bid };
    } catch (error) {
        console.log(">>> Error in updateBidService: ", error);
        return { EM: "Internal server error while updating bid.", EC: 500, DT: "" };
    }
};

const withdrawBidService = async (handymanId, jobId, bidId) => {
    const t = await db.transaction();
    try {
        const bid = await Bid.findOne({
            where: { id: bidId, handyman_id: handymanId, job_id: jobId },
            transaction: t
        });
        if (!bid) {
            await t.rollback();
            return { EM: "Bid not found or you do not have permission to withdraw it.", EC: 404, DT: "" };
        }
        if (bid.status !== 'PENDING') {
            await t.rollback();
            return { EM: "Cannot withdraw a bid that is not pending.", EC: 400, DT: "" };
        }

        const job = await Job.findByPk(jobId, {
            transaction: t,
            lock: t.LOCK.UPDATE
        });
        if (!job) {
            await t.rollback();
            return { EM: "Job not found.", EC: 404, DT: "" };
        }
        if (!['POSTED', 'BIDDING'].includes(job.current_status)) {
            await t.rollback();
            return {
                EM: "Cannot withdraw bid while the job is locked for deposit or already accepted.",
                EC: 409,
                DT: ""
            };
        }

        await bid.update({ status: 'WITHDRAWN' }, { transaction: t });

        const remainingActiveBids = await Bid.count({
            where: { job_id: jobId, status: 'PENDING' },
            transaction: t
        });

        if (remainingActiveBids === 0) {
            if (job.current_status === 'BIDDING') {
                await job.update({ current_status: 'POSTED' }, { transaction: t });
                await JobStatusHistory.create({
                    job_id: jobId,
                    changed_by_user_id: handymanId,
                    old_status: 'BIDDING',
                    new_status: 'POSTED'
                }, { transaction: t });
            }
        }

        await t.commit();
        return { EM: "Bid withdrawn successfully.", EC: 0, DT: "" };
    } catch (error) {
        await t.rollback();
        console.log(">>> Error in withdrawBidService: ", error);
        return { EM: "Internal server error while withdrawing bid.", EC: 500, DT: "" };
    }
};

const getMyBidsService = async (handymanId) => {
    try {
        const bids = await Bid.findAll({
            where: {
                handyman_id: handymanId,
                status: { [Op.ne]: 'WITHDRAWN' }
            },
            include: [
                {
                    model: Job,
                    attributes: [
                        'id', 'current_status', 'service_address', 'scheduled_at',
                        'estimated_budget_min', 'estimated_budget_max', 'final_agreed_price',
                        'selected_handyman_id', 'province_code', 'ward_code', 'createdAt'
                    ],
                    include: [
                        {
                            model: Service,
                            attributes: ['id', 'name', 'icon_url']
                        },
                        {
                            model: Province,
                            attributes: ['province_code', 'name'],
                            required: false
                        },
                        {
                            model: Ward,
                            attributes: ['ward_code', 'name'],
                            required: false
                        }
                    ]
                }
            ],
            order: [['createdAt', 'DESC']]
        });

        const unlockedStatuses = [
            'ACCEPTED', 'EN_ROUTE', 'ARRIVED',
            'IN_PROGRESS', 'WARRANTY', 'CLOSED'
        ];
        const safeBids = bids.map((bid) => {
            const data = bid.toJSON();
            const job = data.Job;
            const contactUnlocked = bid.status === 'WON'
                && job?.selected_handyman_id === handymanId
                && unlockedStatuses.includes(job?.current_status);

            if (job && !contactUnlocked) {
                job.service_address = [
                    job.Ward?.name,
                    job.Province?.name
                ].filter(Boolean).join(', ');
            }

            return data;
        });

        return { EM: "My bids retrieved successfully.", EC: 0, DT: safeBids };
    } catch (error) {
        console.log(">>> Error in getMyBidsService: ", error);
        return { EM: "Internal server error.", EC: 500, DT: [] };
    }
};

export { submitBidService, updateBidService, withdrawBidService, getMyBidsService };
