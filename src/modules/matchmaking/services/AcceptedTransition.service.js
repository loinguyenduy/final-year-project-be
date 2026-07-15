import { Op } from 'sequelize';
import Bid from '../models/Bid.model.js';
import JobArrivalRequest from '../models/JobArrivalRequest.model.js';
import JobStatusHistory from '../models/JobStatusHistory.model.js';

const assertTransitionInput = ({
  job,
  selectedBid,
  depositTransaction,
  depositAmount,
  transaction
}) => {
  if (!transaction) {
    throw new Error('transitionJobToAccepted requires an existing transaction.');
  }
  if (!job || !selectedBid || !depositTransaction) {
    throw new Error('Missing job, selected bid, or deposit transaction.');
  }
  if (selectedBid.job_id !== job.id || depositTransaction.job_id !== job.id) {
    throw new Error('Accepted transition relationships are inconsistent.');
  }
  if (depositTransaction.transaction_type !== 'DEPOSIT_10'
    || depositTransaction.status !== 'SUCCESS'
    || Number(depositTransaction.amount) !== Number(depositAmount)) {
    throw new Error('Deposit transaction is not valid for the accepted transition.');
  }
};

const transitionJobToAccepted = async ({
  job,
  selectedBid,
  depositTransaction,
  depositAmount,
  changedByUserId,
  sourceStatus,
  transaction
}) => {
  assertTransitionInput({
    job,
    selectedBid,
    depositTransaction,
    depositAmount,
    transaction
  });

  if (job.current_status === 'ACCEPTED') {
    const currentAcceptanceCycle = Number(job.acceptance_cycle);
    if (!Number.isInteger(currentAcceptanceCycle) || currentAcceptanceCycle <= 0) {
      throw new Error('Accepted job has an invalid acceptance cycle. Run the guarded legacy backfill.');
    }

    const isSameAcceptedTransition = job.selected_bid_id === selectedBid.id
      && job.selected_handyman_id === selectedBid.handyman_id
      && job.deposit_transaction_id === depositTransaction.id;

    if (!isSameAcceptedTransition) {
      throw new Error('Job is already accepted with a different acceptance context.');
    }

    return {
      transitioned: false,
      acceptedAt: job.accepted_at,
      acceptanceCycle: currentAcceptanceCycle
    };
  }

  if (job.current_status !== sourceStatus) {
    throw new Error(`Job must transition from ${sourceStatus} to ACCEPTED.`);
  }

  const acceptedAt = new Date();
  const previousAcceptanceCycle = Number(job.acceptance_cycle || 0);
  if (!Number.isInteger(previousAcceptanceCycle) || previousAcceptanceCycle < 0) {
    throw new Error('Job has an invalid acceptance cycle.');
  }
  const acceptanceCycle = previousAcceptanceCycle + 1;

  await JobArrivalRequest.update(
    {
      status: 'SUPERSEDED',
      responded_at: acceptedAt,
      responded_by_user_id: null
    },
    {
      where: { job_id: job.id, status: 'PENDING' },
      transaction
    }
  );

  await selectedBid.update({ status: 'WON' }, { transaction });
  await Bid.update(
    { status: 'LOST' },
    {
      where: {
        job_id: job.id,
        id: { [Op.ne]: selectedBid.id },
        status: 'PENDING'
      },
      transaction
    }
  );

  await job.update({
    selected_bid_id: selectedBid.id,
    selected_handyman_id: selectedBid.handyman_id,
    final_agreed_price: selectedBid.proposed_price,
    deposit_amount: depositAmount,
    deposit_status: 'HELD',
    deposit_paid_at: acceptedAt,
    deposit_transaction_id: depositTransaction.id,
    current_status: 'ACCEPTED',
    accepted_at: acceptedAt,
    contact_unlocked_at: acceptedAt,
    acceptance_cycle: acceptanceCycle,
    en_route_at: null,
    en_route_gps_lat: null,
    en_route_gps_long: null,
    en_route_gps_accuracy_meters: null,
    en_route_distance_meters: null,
    en_route_estimated_arrival_minutes: null,
    arrived_at: null,
    arrival_confirmed_by_user_id: null
  }, { transaction });

  await JobStatusHistory.create({
    job_id: job.id,
    changed_by_user_id: changedByUserId,
    old_status: sourceStatus,
    new_status: 'ACCEPTED'
  }, { transaction });

  return { transitioned: true, acceptedAt, acceptanceCycle };
};

export { transitionJobToAccepted };
