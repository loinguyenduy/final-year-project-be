import Province from '../models/Province.model.js';
import Ward from '../models/Ward.model.js';
import { parseCoordinatePair } from '../utils/location.util.js';

const DEFAULT_BASE_URL = 'https://api.opencagedata.com/geocode/v1/json';
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_CACHE_MAX_ENTRIES = 250;
const MIN_PROVIDER_INTERVAL_MS = 1000;

const cache = new Map();
let lastProviderRequestAt = 0;

const readPositiveInteger = (value, fallback) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const getConfig = () => ({
    apiKey: String(process.env.OPENCAGE_API_KEY || '').trim(),
    baseUrl: String(process.env.OPENCAGE_BASE_URL || DEFAULT_BASE_URL).trim(),
    timeoutMs: readPositiveInteger(process.env.GEOCODING_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    cacheTtlMs: readPositiveInteger(process.env.GEOCODING_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS),
    cacheMaxEntries: readPositiveInteger(
        process.env.GEOCODING_CACHE_MAX_ENTRIES,
        DEFAULT_CACHE_MAX_ENTRIES
    )
});

const normalizeCacheKey = (value) => value.trim().toLowerCase().replace(/\s+/g, ' ');

const getCachedValue = (key) => {
    const cached = cache.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
        cache.delete(key);
        return null;
    }
    return cached.value;
};

const setCachedValue = (key, value, ttlMs, maxEntries) => {
    if (cache.size >= maxEntries) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey) cache.delete(oldestKey);
    }
    cache.set(key, { value, expiresAt: Date.now() + ttlMs });
};

const requestOpenCage = async ({ query, cacheKey }) => {
    const config = getConfig();
    if (!config.apiKey) {
        return {
            EM: 'Geocoding service is not configured.',
            EC: 503,
            DT: ''
        };
    }

    const cached = getCachedValue(cacheKey);
    if (cached) {
        return { EM: 'Location resolved from cache.', EC: 0, DT: cached };
    }

    const now = Date.now();
    const retryAfterMs = MIN_PROVIDER_INTERVAL_MS - (now - lastProviderRequestAt);
    if (retryAfterMs > 0) {
        return {
            EM: 'Geocoding is temporarily rate limited. Please try again in a moment.',
            EC: 429,
            DT: { retry_after_ms: retryAfterMs }
        };
    }
    lastProviderRequestAt = now;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
        const url = new URL(config.baseUrl);
        url.searchParams.set('q', query);
        url.searchParams.set('key', config.apiKey);
        url.searchParams.set('language', 'vi');
        url.searchParams.set('countrycode', 'vn');
        url.searchParams.set('limit', '1');
        url.searchParams.set('no_annotations', '1');

        const response = await fetch(url, {
            headers: { 'Accept': 'application/json' },
            signal: controller.signal
        });

        if (response.status === 429) {
            return {
                EM: 'Geocoding provider rate limit reached. Please try again shortly.',
                EC: 429,
                DT: ''
            };
        }
        if (!response.ok) {
            return {
                EM: 'Geocoding provider is temporarily unavailable.',
                EC: 502,
                DT: ''
            };
        }

        const data = await response.json();
        const result = Array.isArray(data?.results) ? data.results[0] : null;
        if (!result?.geometry) {
            return { EM: 'No matching location was found.', EC: 404, DT: '' };
        }

        const providerCoordinates = parseCoordinatePair(
            result.geometry.lat,
            result.geometry.lng,
            { required: true }
        );
        if (!providerCoordinates.valid) {
            return { EM: 'Geocoding provider returned invalid coordinates.', EC: 502, DT: '' };
        }

        const value = {
            provider_address: result.formatted || '',
            gps_lat: providerCoordinates.latitude,
            gps_long: providerCoordinates.longitude
        };
        setCachedValue(cacheKey, value, config.cacheTtlMs, config.cacheMaxEntries);
        return { EM: 'Location resolved successfully.', EC: 0, DT: value };
    } catch (error) {
        if (error?.name === 'AbortError') {
            return { EM: 'Geocoding request timed out.', EC: 502, DT: '' };
        }
        console.error('Geocoding provider request failed:', error?.message || 'Unknown error');
        return { EM: 'Geocoding provider is temporarily unavailable.', EC: 502, DT: '' };
    } finally {
        clearTimeout(timeout);
    }
};

const geocodeAddressService = async ({ provinceCode, wardCode, detailAddress }) => {
    const normalizedDetailAddress = String(detailAddress || '').trim();
    if (!provinceCode || !wardCode || !normalizedDetailAddress) {
        return {
            EM: 'province_code, ward_code and detail_address are required.',
            EC: 400,
            DT: ''
        };
    }

    const [province, ward] = await Promise.all([
        Province.findOne({ where: { province_code: provinceCode } }),
        Ward.findOne({ where: { ward_code: wardCode, province_code: provinceCode } })
    ]);

    if (!province) return { EM: 'Invalid province selected.', EC: 400, DT: '' };
    if (!ward) {
        return {
            EM: 'Invalid ward selected or ward does not belong to the selected province.',
            EC: 400,
            DT: ''
        };
    }

    const serviceAddress = `${normalizedDetailAddress}, ${ward.name}, ${province.name}`;
    const query = `${serviceAddress}, Việt Nam`;
    const result = await requestOpenCage({
        query,
        cacheKey: `forward:${normalizeCacheKey(query)}`
    });

    if (result.EC !== 0) return result;
    return {
        EM: result.EM,
        EC: 0,
        DT: {
            service_address: serviceAddress,
            provider_address: result.DT.provider_address,
            gps_lat: result.DT.gps_lat,
            gps_long: result.DT.gps_long
        }
    };
};

const reverseGeocodeService = async ({ gpsLat, gpsLong }) => {
    const coordinates = parseCoordinatePair(gpsLat, gpsLong, { required: true });
    if (!coordinates.valid) return { EM: coordinates.error, EC: 400, DT: '' };

    const query = `${coordinates.latitude},${coordinates.longitude}`;
    const cacheKey = `reverse:${coordinates.latitude.toFixed(6)},${coordinates.longitude.toFixed(6)}`;
    const result = await requestOpenCage({ query, cacheKey });

    if (result.EC !== 0) return result;
    return {
        EM: result.EM,
        EC: 0,
        DT: {
            service_address: result.DT.provider_address || 'Selected map location',
            gps_lat: coordinates.latitude,
            gps_long: coordinates.longitude
        }
    };
};

export { geocodeAddressService, reverseGeocodeService };
