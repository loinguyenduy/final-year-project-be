const LOCATION_SOURCES = Object.freeze({
    CURRENT_GPS: 'CURRENT_GPS',
    GEOCODED_ADDRESS: 'GEOCODED_ADDRESS',
    PROFILE_ADDRESS: 'PROFILE_ADDRESS',
    MANUAL_MAP_PIN: 'MANUAL_MAP_PIN',
    ADDRESS_ONLY: 'ADDRESS_ONLY'
});

const ALLOWED_SOURCES_BY_OPTION = Object.freeze({
    1: new Set([
        LOCATION_SOURCES.GEOCODED_ADDRESS,
        LOCATION_SOURCES.MANUAL_MAP_PIN,
        LOCATION_SOURCES.ADDRESS_ONLY
    ]),
    2: new Set([
        LOCATION_SOURCES.PROFILE_ADDRESS,
        LOCATION_SOURCES.GEOCODED_ADDRESS,
        LOCATION_SOURCES.MANUAL_MAP_PIN,
        LOCATION_SOURCES.ADDRESS_ONLY
    ]),
    3: new Set([
        LOCATION_SOURCES.CURRENT_GPS,
        LOCATION_SOURCES.MANUAL_MAP_PIN
    ])
});

const hasCoordinateValue = (value) => (
    value !== undefined
    && value !== null
    && value !== ''
    && value !== 'null'
);

const parseCoordinatePair = (latitudeValue, longitudeValue, { required = false } = {}) => {
    const hasLatitude = hasCoordinateValue(latitudeValue);
    const hasLongitude = hasCoordinateValue(longitudeValue);

    if (hasLatitude !== hasLongitude) {
        return {
            valid: false,
            error: 'gps_lat and gps_long must both be provided or both be null.'
        };
    }

    if (!hasLatitude) {
        if (required) {
            return { valid: false, error: 'gps_lat and gps_long are required.' };
        }
        return { valid: true, latitude: null, longitude: null, hasCoordinates: false };
    }

    const latitude = Number(latitudeValue);
    const longitude = Number(longitudeValue);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return { valid: false, error: 'gps_lat and gps_long must be finite numbers.' };
    }
    if (latitude < -90 || latitude > 90) {
        return { valid: false, error: 'gps_lat must be between -90 and 90.' };
    }
    if (longitude < -180 || longitude > 180) {
        return { valid: false, error: 'gps_long must be between -180 and 180.' };
    }

    return { valid: true, latitude, longitude, hasCoordinates: true };
};

const parseLocationConfirmed = (value) => {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return null;
};

const validateJobLocationInput = ({
    addressOption,
    gpsLat,
    gpsLong,
    locationSource,
    locationConfirmed
}) => {
    const option = Number(addressOption);
    const allowedSources = ALLOWED_SOURCES_BY_OPTION[option];

    if (!allowedSources) {
        return { valid: false, error: 'Invalid address_option. Must be 1, 2, or 3.' };
    }
    if (!allowedSources.has(locationSource)) {
        return {
            valid: false,
            error: `location_source ${locationSource || '(missing)'} is not valid for address_option ${option}.`
        };
    }

    const coordinates = parseCoordinatePair(gpsLat, gpsLong, { required: option === 3 });
    if (!coordinates.valid) return coordinates;

    const confirmed = parseLocationConfirmed(locationConfirmed);
    if (confirmed === null) {
        return { valid: false, error: 'location_confirmed must be true or false.' };
    }

    if (coordinates.hasCoordinates) {
        if (!confirmed) {
            return { valid: false, error: 'Coordinates must be confirmed before creating the job.' };
        }
        if (locationSource === LOCATION_SOURCES.ADDRESS_ONLY) {
            return { valid: false, error: 'ADDRESS_ONLY cannot be used when coordinates are present.' };
        }
    } else {
        if (locationSource !== LOCATION_SOURCES.ADDRESS_ONLY || confirmed) {
            return {
                valid: false,
                error: 'A job without coordinates must use ADDRESS_ONLY and location_confirmed=false.'
            };
        }
    }

    return {
        valid: true,
        addressOption: option,
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
        hasCoordinates: coordinates.hasCoordinates,
        locationSource,
        locationConfirmed: confirmed
    };
};

const coordinatesMatch = (latitudeA, longitudeA, latitudeB, longitudeB, tolerance = 0.00000001) => {
    const first = parseCoordinatePair(latitudeA, longitudeA);
    const second = parseCoordinatePair(latitudeB, longitudeB);
    if (!first.valid || !second.valid || !first.hasCoordinates || !second.hasCoordinates) return false;

    return Math.abs(first.latitude - second.latitude) <= tolerance
        && Math.abs(first.longitude - second.longitude) <= tolerance;
};

// Haversine formula — returns distance in kilometres.
const calculateDistanceKm = (latitudeA, longitudeA, latitudeB, longitudeB) => {
    const R = 6371;
    const toRad = value => (value * Math.PI) / 180;
    const dLat = toRad(latitudeB - latitudeA);
    const dLon = toRad(longitudeB - longitudeA);
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(toRad(latitudeA)) * Math.cos(toRad(latitudeB)) * Math.sin(dLon / 2) ** 2;
    return parseFloat((R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))).toFixed(2));
};

export {
    LOCATION_SOURCES,
    parseCoordinatePair,
    validateJobLocationInput,
    coordinatesMatch,
    calculateDistanceKm
};
