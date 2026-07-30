import { Op } from 'sequelize';
import Job from '../models/Job.model.js';
import Bid from '../models/Bid.model.js';
import JobStatusHistory from '../models/JobStatusHistory.model.js';
import Service from '../models/Service.model.js';
import Province from '../models/Province.model.js';
import Ward from '../models/Ward.model.js';
import db from '../../../core/database/connection.js';
import {
    JOB_LIFECYCLE_EVENTS,
    emitJobLifecycleEvent
} from '../sockets/JobLifecycle.gateway.js';
import { getReviewStateMap } from '../../dispute/services/Review.service.js';
import { actionForStatus, ACTIVE_STATUSES } from '../../identity/services/ParticipantRead.service.js';

const emitBidEvent = ({ event, job, bid, previousStatus = null }) => emitJobLifecycleEvent({
    event,
    userIds: [job.customer_id],
    payload: {
        job_id: job.id,
        bid_id: bid.id,
        handyman_id: bid.handyman_id,
        previous_status: previousStatus,
        current_status: job.current_status,
        acceptance_cycle: Number(job.acceptance_cycle || 0),
        occurred_at: new Date()
    }
});

const serializeBid = (bid) => ({
    id: bid.id,
    job_id: bid.job_id,
    handyman_id: bid.handyman_id,
    proposed_price: Number(bid.proposed_price),
    message: bid.message,
    eta: bid.eta,
    estimated_duration_hours: bid.estimated_duration_hours,
    status: bid.status,
    created_at: bid.createdAt,
    updated_at: bid.updatedAt
});

const submitBidService = async (handymanId, jobId, bidData) => {
    const t = await db.transaction();
    try {
        const { proposed_price, message, eta, estimated_duration_hours } = bidData;

        if (!proposed_price || isNaN(Number(proposed_price)) || Number(proposed_price) <= 0) {
            await t.rollback();
            return { EM: "Proposed price must be a positive number.", EC: 400, DT: "" };
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
            return { EM: "This job is no longer accepting bids.", EC: 400, DT: "" };
        }
        const originalJobStatus = job.current_status;

        // Prevent customer from bidding on their own job
        if (job.customer_id === handymanId) {
            await t.rollback();
            return { EM: "You cannot bid on your own job.", EC: 403, DT: "" };
        }

        const cancelledByHandymanBid = await Bid.findOne({
            where: {
                handyman_id: handymanId,
                job_id: jobId,
                status: 'CANCELLED_BY_HANDYMAN'
            },
            transaction: t
        });
        if (cancelledByHandymanBid) {
            await t.rollback();
            return {
                EM: 'You cannot bid again on a job you cancelled after acceptance.',
                EC: 409,
                code: 'HANDYMAN_CANNOT_REBID_CANCELLED_JOB',
                DT: ''
            };
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

        const customerCancelledBid = await Bid.findOne({
            where: {
                handyman_id: handymanId,
                job_id: jobId,
                status: 'CANCELLED_BY_CUSTOMER'
            },
            transaction: t
        });

        if (customerCancelledBid) {
            await customerCancelledBid.update({
                proposed_price,
                message: message || null,
                eta: eta ? new Date(eta) : null,
                estimated_duration_hours: estimated_duration_hours
                    ? Number(estimated_duration_hours)
                    : null,
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
            emitBidEvent({
                event: JOB_LIFECYCLE_EVENTS.BID_SUBMITTED,
                job,
                bid: customerCancelledBid,
                previousStatus: originalJobStatus
            });
            return {
                EM: 'Customer-cancelled bid reactivated successfully.',
                EC: 0,
                DT: serializeBid(customerCancelledBid),
                HTTP_STATUS: 200
            };
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
        emitBidEvent({
            event: JOB_LIFECYCLE_EVENTS.BID_SUBMITTED,
            job,
            bid: newBid,
            previousStatus: originalJobStatus
        });
        return {
            EM: "Bid submitted successfully.",
            EC: 0,
            DT: serializeBid(newBid),
            HTTP_STATUS: 201
        };
    } catch (error) {
        if (!t.finished) await t.rollback();
        console.log(">>> Error in submitBidService: ", error);
        return { EM: "Internal server error while submitting bid.", EC: 500, DT: "" };
    }
};

const updateBidService = async (handymanId, jobId, bidId, bidData) => {
    const t = await db.transaction();
    try {
        const { proposed_price, message, eta, estimated_duration_hours } = bidData;

        const job = await Job.findByPk(jobId, {
            transaction: t,
            lock: t.LOCK.UPDATE
        });
        if (!job) {
            await t.rollback();
            return { EM: "Job not found.", EC: 404, DT: "" };
        }
        const bid = await Bid.findOne({
            where: { id: bidId, handyman_id: handymanId, job_id: jobId },
            transaction: t,
            lock: t.LOCK.UPDATE
        });
        if (!bid) {
            await t.rollback();
            return { EM: "Bid not found or you do not have permission to update it.", EC: 404, DT: "" };
        }
        if (bid.status !== 'PENDING') {
            await t.rollback();
            return { EM: "Cannot update a bid that is no longer pending.", EC: 400, DT: "" };
        }
        if (!['POSTED', 'BIDDING'].includes(job.current_status)) {
            await t.rollback();
            return { EM: "Cannot update bid — the job is no longer open for bidding.", EC: 400, DT: "" };
        }

        if (proposed_price !== undefined && (isNaN(Number(proposed_price)) || Number(proposed_price) <= 0)) {
            await t.rollback();
            return { EM: "Proposed price must be a positive number.", EC: 400, DT: "" };
        }

        const updatePayload = {};
        if (proposed_price !== undefined) updatePayload.proposed_price = proposed_price;
        if (message !== undefined) updatePayload.message = message;
        if (eta !== undefined) updatePayload.eta = eta ? new Date(eta) : null;
        if (estimated_duration_hours !== undefined) updatePayload.estimated_duration_hours = estimated_duration_hours ? Number(estimated_duration_hours) : null;

        await bid.update(updatePayload, { transaction: t });
        await t.commit();
        emitBidEvent({ event: JOB_LIFECYCLE_EVENTS.BID_UPDATED, job, bid });
        return { EM: "Bid updated successfully.", EC: 0, DT: bid };
    } catch (error) {
        if (!t.finished) await t.rollback();
        console.log(">>> Error in updateBidService: ", error);
        return { EM: "Internal server error while updating bid.", EC: 500, DT: "" };
    }
};

const withdrawBidService = async (handymanId, jobId, bidId) => {
    const t = await db.transaction();
    try {
        const job = await Job.findByPk(jobId, {
            transaction: t,
            lock: t.LOCK.UPDATE
        });
        if (!job) {
            await t.rollback();
            return { EM: "Job not found.", EC: 404, DT: "" };
        }
        const bid = await Bid.findOne({
            where: { id: bidId, handyman_id: handymanId, job_id: jobId },
            transaction: t,
            lock: t.LOCK.UPDATE
        });
        if (!bid) {
            await t.rollback();
            return { EM: "Bid not found or you do not have permission to withdraw it.", EC: 404, DT: "" };
        }
        if (bid.status !== 'PENDING') {
            await t.rollback();
            return { EM: "Cannot withdraw a bid that is not pending.", EC: 400, DT: "" };
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
        emitBidEvent({ event: JOB_LIFECYCLE_EVENTS.BID_WITHDRAWN, job, bid });
        return { EM: "Bid withdrawn successfully.", EC: 0, DT: "" };
    } catch (error) {
        if (!t.finished) await t.rollback();
        console.log(">>> Error in withdrawBidService: ", error);
        return { EM: "Internal server error while withdrawing bid.", EC: 500, DT: "" };
    }
};

const getMyBidsService = async (handymanId, query = {}) => {
    try {
        const page = Math.max(1, Number.parseInt(query.page || '1', 10) || 1);
        const pageSize = Math.min(100, Math.max(1, Number.parseInt(query.page_size || '20', 10) || 20));
        const view = String(query.view || 'ALL').toUpperCase();
        const status = String(query.status || 'ALL').toUpperCase();
        const sort = String(query.sort || 'UPDATED_DESC').toUpperCase();
        if (!['ALL', 'BIDDING', 'ASSIGNED', 'NEEDS_ACTION', 'CLOSED', 'CANCELLED'].includes(view)
            || !['UPDATED_DESC', 'SCHEDULED_ASC', 'CREATED_DESC', 'BID_CREATED_DESC'].includes(sort)
            || (status !== 'ALL' && !Job.rawAttributes.current_status.values.includes(status))) {
            return { EM: 'My Jobs filters are invalid.', EC: 400, code: 'VALIDATION_ERROR', DT: '' };
        }
        const jobWhere = {
            ...(status !== 'ALL' ? { current_status: status }
                : view === 'BIDDING' ? { current_status: { [Op.in]: ['POSTED', 'BIDDING', 'PENDING_DEPOSIT'] } }
                    : view === 'CLOSED' ? { current_status: 'CLOSED' }
                        : view === 'CANCELLED' ? { current_status: 'CANCELLED' }
                            : {}),
            ...(view === 'ASSIGNED' ? { selected_handyman_id: handymanId, current_status: { [Op.in]: ACTIVE_STATUSES } } : {})
        };
        const order = {
            UPDATED_DESC: [[Job, 'updatedAt', 'DESC'], ['id', 'DESC']],
            SCHEDULED_ASC: [[Job, 'scheduled_at', 'ASC'], ['id', 'ASC']],
            CREATED_DESC: [[Job, 'createdAt', 'DESC'], ['id', 'DESC']],
            BID_CREATED_DESC: [['createdAt', 'DESC'], ['id', 'DESC']]
        }[sort];
        let needsActionTotal = null;
        let needsActionBidIds = null;
        if (view === 'NEEDS_ACTION') {
            const actionStatuses = Job.rawAttributes.current_status.values.filter((entry) => actionForStatus(entry, 'HANDYMAN'));
            const candidateBids = await Bid.findAll({
                where: { handyman_id: handymanId, status: { [Op.ne]: 'WITHDRAWN' } },
                attributes: ['id'],
                include: [{
                    model: Job,
                    attributes: ['id', 'current_status', 'acceptance_cycle', 'customer_id', 'selected_handyman_id', 'createdAt', 'updatedAt', 'scheduled_at'],
                    where: {
                        ...(status !== 'ALL' ? { current_status: status } : { current_status: { [Op.in]: [...new Set([...actionStatuses, 'CLOSED'])] } })
                    },
                    required: true
                }],
                order
            });
            const candidateStates = await getReviewStateMap({ jobs: candidateBids.map((entry) => entry.Job), actor: { id: handymanId, role: 'HANDYMAN' } });
            const actionable = candidateBids.filter((entry) => candidateStates.get(entry.Job.id)?.status === 'PENDING'
                || (entry.Job.selected_handyman_id === handymanId
                    && Boolean(actionForStatus(entry.Job.current_status, 'HANDYMAN'))));
            needsActionTotal = actionable.length;
            needsActionBidIds = actionable
                .slice((page - 1) * pageSize, page * pageSize)
                .map((entry) => entry.id);
            if (!needsActionBidIds.length) {
                return { EM: 'My bids retrieved successfully.', EC: 0, DT: { items: [], pagination: { page, page_size: pageSize, total_items: needsActionTotal, total_pages: Math.ceil(needsActionTotal / pageSize) }, filters: { view, status, sort } } };
            }
        }
        const { rows: bids, count } = await Bid.findAndCountAll({
            where: {
                handyman_id: handymanId,
                status: { [Op.ne]: 'WITHDRAWN' },
                ...(needsActionBidIds ? { id: { [Op.in]: needsActionBidIds } } : {})
            },
            include: [
                {
                    model: Job,
                    attributes: [
                        'id', 'current_status', 'service_address', 'scheduled_at',
                        'estimated_budget_min', 'estimated_budget_max', 'final_agreed_price',
                        'selected_handyman_id', 'province_code', 'ward_code', 'createdAt'
                    ],
                    where: jobWhere,
                    required: true,
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
            order,
            limit: pageSize,
            offset: needsActionBidIds ? 0 : (page - 1) * pageSize,
            distinct: true
        });

        const unlockedStatuses = [
            'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'QUOTE_PENDING', 'PAYMENT_PENDING',
            'CANCELLATION_REVIEW', 'IN_PROGRESS', 'WARRANTY', 'CLOSED', 'CANCELLED'
        ];
        const reviewStates = await getReviewStateMap({ jobs: bids.map((entry) => entry.Job).filter(Boolean), actor: { id: handymanId, role: 'HANDYMAN' } });
        const safeBids = bids.map((bid) => {
            const data = bid.toJSON();
            const job = data.Job;
            const selectedLifecycleBid = [
                'WON',
                'CANCELLED_BY_CUSTOMER',
                'CANCELLED_BY_HANDYMAN'
            ].includes(bid.status);
            const contactUnlocked = selectedLifecycleBid
                && job?.selected_handyman_id === handymanId
                && unlockedStatuses.includes(job?.current_status);

            if (job && !contactUnlocked) {
                job.service_address = [
                    job.Ward?.name,
                    job.Province?.name
                ].filter(Boolean).join(', ');
            }

            const review = reviewStates.get(job?.id) || { status: 'NOT_AVAILABLE' };
            const actionLabel = review.status === 'PENDING'
                ? 'Rate this customer'
                : job?.selected_handyman_id === handymanId
                    ? actionForStatus(job?.current_status, 'HANDYMAN')
                    : null;
            return { ...data, needs_action: Boolean(actionLabel), action_summary: actionLabel ? { label: actionLabel, destination: `/handyman/jobs/${job.id}` } : null, review_state: review.status };
        });
        const filtered = view === 'NEEDS_ACTION' ? safeBids.filter((entry) => entry.needs_action) : safeBids;
        return { EM: "My bids retrieved successfully.", EC: 0, DT: { items: filtered, pagination: { page, page_size: pageSize, total_items: needsActionTotal ?? count, total_pages: Math.ceil((needsActionTotal ?? count) / pageSize) }, filters: { view, status, sort } } };
    } catch (error) {
        console.log(">>> Error in getMyBidsService: ", error);
        return { EM: "Internal server error.", EC: 500, DT: "" };
    }
};

export { submitBidService, updateBidService, withdrawBidService, getMyBidsService };
