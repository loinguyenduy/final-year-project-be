import {
    calculateDistanceMeters,
    parseCoordinatePair
} from './location.util.js';

const DEFAULT_LIFECYCLE_CONFIG = Object.freeze({
    estimatedSpeedKmh: 25,
    etaBufferMinutes: 5,
    maxEtaMinutes: 1440,
    arrivalWarningMeters: 500,
    arrivalCooldownSeconds: 60,
    maxRejectionsPerCycle: 3
});

const readPositiveNumber = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const readNonNegativeNumber = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const readPositiveInteger = (value, fallback) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const getJobLifecycleConfig = () => ({
    estimatedSpeedKmh: readPositiveNumber(
        process.env.HANDYMAN_ESTIMATED_SPEED_KMH,
        DEFAULT_LIFECYCLE_CONFIG.estimatedSpeedKmh
    ),
    etaBufferMinutes: readNonNegativeNumber(
        process.env.HANDYMAN_ETA_BUFFER_MINUTES,
        DEFAULT_LIFECYCLE_CONFIG.etaBufferMinutes
    ),
    maxEtaMinutes: readPositiveInteger(
        process.env.HANDYMAN_MAX_ETA_MINUTES,
        DEFAULT_LIFECYCLE_CONFIG.maxEtaMinutes
    ),
    arrivalWarningMeters: readNonNegativeNumber(
        process.env.ARRIVAL_DISTANCE_WARNING_METERS,
        DEFAULT_LIFECYCLE_CONFIG.arrivalWarningMeters
    ),
    arrivalCooldownSeconds: readNonNegativeNumber(
        process.env.ARRIVAL_REQUEST_COOLDOWN_SECONDS,
        DEFAULT_LIFECYCLE_CONFIG.arrivalCooldownSeconds
    ),
    maxRejectionsPerCycle: readPositiveInteger(
        process.env.ARRIVAL_MAX_REJECTIONS_PER_CYCLE,
        DEFAULT_LIFECYCLE_CONFIG.maxRejectionsPerCycle
    )
});

const validateGpsEvidence = (payload = {}, { required = false } = {}) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { valid: false, error: 'Request body must be a JSON object.' };
    }

    const allowedFields = new Set(['gps_lat', 'gps_long', 'gps_accuracy_meters']);
    const unknownFields = Object.keys(payload).filter(field => !allowedFields.has(field));
    if (unknownFields.length > 0) {
        return {
            valid: false,
            error: `Unsupported request fields: ${unknownFields.join(', ')}.`
        };
    }

    const coordinates = parseCoordinatePair(payload.gps_lat, payload.gps_long, { required });
    if (!coordinates.valid) return coordinates;

    const hasAccuracy = Object.prototype.hasOwnProperty.call(payload, 'gps_accuracy_meters')
        && payload.gps_accuracy_meters !== null
        && payload.gps_accuracy_meters !== undefined;
    let accuracyMeters = null;
    if (hasAccuracy) {
        if (payload.gps_accuracy_meters === '') {
            return { valid: false, error: 'gps_accuracy_meters must be a non-negative finite number.' };
        }
        accuracyMeters = Number(payload.gps_accuracy_meters);
        if (!Number.isFinite(accuracyMeters) || accuracyMeters < 0) {
            return { valid: false, error: 'gps_accuracy_meters must be a non-negative finite number.' };
        }
        if (!coordinates.hasCoordinates) {
            return { valid: false, error: 'gps_accuracy_meters requires gps_lat and gps_long.' };
        }
    }

    return {
        valid: true,
        hasCoordinates: coordinates.hasCoordinates,
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
        accuracyMeters
    };
};

const buildDistanceSnapshot = ({ handymanCoordinates, jobCoordinates }) => {
    if (!handymanCoordinates.hasCoordinates || !jobCoordinates.hasCoordinates) {
        return { distanceMeters: null, distanceKm: null };
    }

    const distanceMeters = calculateDistanceMeters(
        handymanCoordinates.latitude,
        handymanCoordinates.longitude,
        jobCoordinates.latitude,
        jobCoordinates.longitude
    );
    return {
        distanceMeters,
        distanceKm: Number((distanceMeters / 1000).toFixed(2))
    };
};

const calculateEstimatedArrivalMinutes = (distanceMeters, config = getJobLifecycleConfig()) => {
    if (distanceMeters === null || distanceMeters === undefined) return null;
    const travelMinutes = Math.ceil((distanceMeters / 1000 / config.estimatedSpeedKmh) * 60);
    return Math.min(
        config.maxEtaMinutes,
        Math.ceil(travelMinutes + config.etaBufferMinutes)
    );
};

const getArrivalLocationWarning = (distanceMeters, config = getJobLifecycleConfig()) => {
    if (distanceMeters === null || distanceMeters === undefined) return 'LOCATION_UNAVAILABLE';
    return distanceMeters <= config.arrivalWarningMeters ? 'NEAR_JOB' : 'FAR_FROM_JOB';
};

const getCooldownRemainingSeconds = (respondedAt, now, cooldownSeconds) => {
    if (!respondedAt || cooldownSeconds <= 0) return 0;
    const elapsedMs = now.getTime() - new Date(respondedAt).getTime();
    return Math.max(0, Math.ceil((cooldownSeconds * 1000 - elapsedMs) / 1000));
};

const toNullableNumber = (value) => (
    value === null || value === undefined ? null : Number(value)
);

const buildEnRouteDto = (job, { includeRawGps = false } = {}) => {
    if (!job?.en_route_at && job?.current_status === 'ACCEPTED') return null;

    const distanceMeters = toNullableNumber(job?.en_route_distance_meters);
    const dto = {
        started_at: job?.en_route_at || null,
        distance_meters: distanceMeters,
        distance_km: distanceMeters === null
            ? null
            : Number((distanceMeters / 1000).toFixed(2)),
        estimated_arrival_minutes: toNullableNumber(
            job?.en_route_estimated_arrival_minutes
        ),
        gps_accuracy_meters: toNullableNumber(job?.en_route_gps_accuracy_meters)
    };

    if (includeRawGps) {
        dto.gps_lat = toNullableNumber(job?.en_route_gps_lat);
        dto.gps_long = toNullableNumber(job?.en_route_gps_long);
    }
    return dto;
};

const buildArrivalRequestDto = (request, { includeRawGps = false } = {}) => {
    if (!request) return null;
    const source = typeof request.toJSON === 'function' ? request.toJSON() : request;
    const distanceMeters = toNullableNumber(source.distance_to_job_meters);
    const dto = {
        id: source.id,
        status: source.status,
        acceptance_cycle: Number(source.acceptance_cycle),
        requested_at: source.requested_at,
        responded_at: source.responded_at,
        distance_to_job_meters: distanceMeters,
        distance_to_job_km: distanceMeters === null
            ? null
            : Number((distanceMeters / 1000).toFixed(2)),
        gps_accuracy_meters: toNullableNumber(source.request_gps_accuracy_meters),
        location_warning: source.location_warning,
        rejection_reason: source.rejection_reason,
        rejection_reason_text: source.rejection_reason_text
    };

    if (includeRawGps) {
        dto.gps_lat = toNullableNumber(source.request_gps_lat);
        dto.gps_long = toNullableNumber(source.request_gps_long);
    }
    return dto;
};

export {
    DEFAULT_LIFECYCLE_CONFIG,
    buildDistanceSnapshot,
    buildArrivalRequestDto,
    buildEnRouteDto,
    calculateEstimatedArrivalMinutes,
    getArrivalLocationWarning,
    getCooldownRemainingSeconds,
    getJobLifecycleConfig,
    toNullableNumber,
    validateGpsEvidence
};
