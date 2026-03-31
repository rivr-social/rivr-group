/**
 * @module google
 * @description Google Places and Geocoding integration helpers with normalized
 * response shapes and explicit API error handling.
 *
 * Purpose:
 * - Expose environment-backed API key accessors for Places and Maps/Geocoding.
 * - Provide typed wrappers for autocomplete, place details, and address geocoding.
 * - Normalize raw Google response payloads into application-specific interfaces.
 *
 * Key exports:
 * - `getGooglePlacesApiKey()`, `getGoogleMapsApiKey()`
 * - `isGooglePlacesConfigured()`, `isGoogleMapsConfigured()`
 * - `getPlaceAutocomplete()`, `getPlaceDetails()`, `geocodeAddress()`
 * - `GoogleApiError` and exported result interfaces
 *
 * Dependencies:
 * - `getEnv` from `@/lib/env`
 * - global `fetch` API
 *
 * Security:
 * - API keys are read from environment variables and never hard-coded.
 * - User-provided input is passed through `URLSearchParams` to avoid malformed
 *   query strings and to ensure proper URL encoding.
 */

import { getEnv } from '@/lib/env';

/**
 * Base URL for Google Places API methods.
 */
const PLACES_BASE_URL = 'https://maps.googleapis.com/maps/api/place';
/**
 * Base URL for Google Geocoding API methods.
 */
const GEOCODE_BASE_URL = 'https://maps.googleapis.com/maps/api/geocode';

/**
 * Default search radius for nearby-biased autocomplete requests (50 km).
 */
const DEFAULT_RADIUS_METERS = 50000;
/**
 * Defensive cap to keep payload size predictable and reduce UI noise.
 */
const MAX_AUTOCOMPLETE_RESULTS = 5;

/**
 * Normalized place autocomplete option exposed to the application.
 */
export interface PlaceAutocompleteResult {
  placeId: string;
  description: string;
  mainText: string;
  secondaryText: string;
}

/**
 * Normalized place details payload used by downstream location workflows.
 */
export interface PlaceDetails {
  placeId: string;
  name: string;
  formattedAddress: string;
  lat: number;
  lng: number;
  types: string[];
}

/**
 * Normalized geocoding result shape for address-to-coordinate resolution.
 */
export interface GeocodingResult {
  formattedAddress: string;
  lat: number;
  lng: number;
  placeId: string;
}

/**
 * Returns the Google Places API key.
 *
 * @param _unused - This function does not accept parameters.
 * @returns The API key string
 * @throws Error if GOOGLE_PLACES_API_KEY is required but not configured
 * @example
 * ```ts
 * const placesKey = getGooglePlacesApiKey();
 * ```
 */
export function getGooglePlacesApiKey(): string {
  return getEnv('GOOGLE_PLACES_API_KEY');
}

/**
 * Returns the Google Maps API key.
 *
 * @param _unused - This function does not accept parameters.
 * @returns The API key string
 * @throws Error if GOOGLE_MAPS_API_KEY is required but not configured
 * @example
 * ```ts
 * const mapsKey = getGoogleMapsApiKey();
 * ```
 */
export function getGoogleMapsApiKey(): string {
  return getEnv('GOOGLE_MAPS_API_KEY');
}

/**
 * Checks whether the Google Places API is configured.
 *
 * @param _unused - This function does not accept parameters.
 * @returns true if GOOGLE_PLACES_API_KEY is set
 * @throws {TypeError} Never intentionally thrown; only possible from runtime environment access anomalies.
 * @example
 * ```ts
 * if (!isGooglePlacesConfigured()) {
 *   // Disable place suggestions in this environment.
 * }
 * ```
 */
export function isGooglePlacesConfigured(): boolean {
  return !!process.env.GOOGLE_PLACES_API_KEY;
}

/**
 * Checks whether the Google Maps API is configured.
 *
 * @param _unused - This function does not accept parameters.
 * @returns true if GOOGLE_MAPS_API_KEY is set
 * @throws {TypeError} Never intentionally thrown; only possible from runtime environment access anomalies.
 * @example
 * ```ts
 * const canGeocode = isGoogleMapsConfigured();
 * ```
 */
export function isGoogleMapsConfigured(): boolean {
  return !!process.env.GOOGLE_MAPS_API_KEY;
}

/**
 * Fetches place autocomplete suggestions from the Google Places API.
 *
 * @param input - Partial text input to search for
 * @param options - Optional search configuration
 * @returns Array of autocomplete suggestions
 * @throws {GoogleApiError} When the HTTP request fails or Google returns an API-level error status
 * @example
 * ```ts
 * const suggestions = await getPlaceAutocomplete('1600 Amph');
 * ```
 */
export async function getPlaceAutocomplete(
  input: string,
  options?: {
    lat?: number;
    lng?: number;
    radiusMeters?: number;
    types?: string;
  }
): Promise<PlaceAutocompleteResult[]> {
  const apiKey = getGooglePlacesApiKey();
  if (!apiKey) {
    // Missing key is treated as a non-fatal "feature unavailable" condition.
    return [];
  }

  const params = new URLSearchParams({
    input,
    key: apiKey,
  });

  if (options?.lat !== undefined && options?.lng !== undefined) {
    // Location bias is only applied when both coordinates are provided.
    params.set('location', `${options.lat},${options.lng}`);
    params.set('radius', String(options?.radiusMeters ?? DEFAULT_RADIUS_METERS));
  }

  if (options?.types) {
    params.set('types', options.types);
  }

  const url = `${PLACES_BASE_URL}/autocomplete/json?${params.toString()}`;
  const response = await fetch(url);

  if (!response.ok) {
    // Surface transport-level failures with status metadata for observability and retries.
    throw new GoogleApiError(
      `Places autocomplete request failed: ${response.status} ${response.statusText}`,
      response.status
    );
  }

  const data = await response.json();

  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    // Google can return API-level failures with HTTP 200; validate `status` explicitly.
    throw new GoogleApiError(
      `Places API error: ${data.status} - ${data.error_message ?? 'Unknown error'}`,
      0
    );
  }

  const predictions = data.predictions ?? [];
  return predictions
    .slice(0, MAX_AUTOCOMPLETE_RESULTS)
    // Normalize Google response fields into the app's internal autocomplete type.
    .map((prediction: Record<string, unknown>) => ({
      placeId: prediction.place_id as string,
      description: prediction.description as string,
      mainText: (prediction.structured_formatting as Record<string, string>)?.main_text ?? '',
      secondaryText: (prediction.structured_formatting as Record<string, string>)?.secondary_text ?? '',
    }));
}

/**
 * Fetches detailed information about a place by its place ID.
 *
 * @param placeId - Google Place ID
 * @returns Place details including coordinates
 * @throws {GoogleApiError} When the request fails or Google returns an unexpected non-OK status
 * @example
 * ```ts
 * const details = await getPlaceDetails('ChIJ2eUgeAK6j4ARbn5u_wAGqWA');
 * ```
 */
export async function getPlaceDetails(placeId: string): Promise<PlaceDetails | null> {
  const apiKey = getGooglePlacesApiKey();
  if (!apiKey) {
    // Keep behavior consistent with other helpers: no key means no data.
    return null;
  }

  const params = new URLSearchParams({
    place_id: placeId,
    key: apiKey,
    fields: 'place_id,name,formatted_address,geometry,types',
  });

  const url = `${PLACES_BASE_URL}/details/json?${params.toString()}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new GoogleApiError(
      `Place details request failed: ${response.status} ${response.statusText}`,
      response.status
    );
  }

  const data = await response.json();

  if (data.status !== 'OK') {
    if (data.status === 'NOT_FOUND' || data.status === 'ZERO_RESULTS') {
      // Expected lookup miss; not considered exceptional.
      return null;
    }
    throw new GoogleApiError(
      `Places API error: ${data.status} - ${data.error_message ?? 'Unknown error'}`,
      0
    );
  }

  const result = data.result;
  // Restricting fields in the request above keeps this mapping deterministic.
  return {
    placeId: result.place_id,
    name: result.name,
    formattedAddress: result.formatted_address,
    lat: result.geometry.location.lat,
    lng: result.geometry.location.lng,
    types: result.types ?? [],
  };
}

/**
 * Geocodes an address string to coordinates.
 *
 * @param address - Human-readable address
 * @returns Geocoding result with coordinates, or null if not found
 * @throws {GoogleApiError} When the HTTP request fails or the geocoder returns an error status
 * @example
 * ```ts
 * const geocoded = await geocodeAddress('1600 Amphitheatre Parkway, Mountain View, CA');
 * ```
 */
export async function geocodeAddress(address: string): Promise<GeocodingResult | null> {
  const apiKey = getGoogleMapsApiKey();
  if (!apiKey) {
    // Graceful degradation allows callers to continue flows without hard failure.
    return null;
  }

  const params = new URLSearchParams({
    address,
    key: apiKey,
  });

  const url = `${GEOCODE_BASE_URL}/json?${params.toString()}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new GoogleApiError(
      `Geocoding request failed: ${response.status} ${response.statusText}`,
      response.status
    );
  }

  const data = await response.json();

  if (data.status === 'ZERO_RESULTS') {
    // Explicitly represent no-match results as `null` for predictable caller handling.
    return null;
  }

  if (data.status !== 'OK') {
    throw new GoogleApiError(
      `Geocoding API error: ${data.status} - ${data.error_message ?? 'Unknown error'}`,
      0
    );
  }

  const result = data.results[0];
  // Business rule: intentionally return only the top-ranked geocoding candidate.
  return {
    formattedAddress: result.formatted_address,
    lat: result.geometry.location.lat,
    lng: result.geometry.location.lng,
    placeId: result.place_id,
  };
}

/**
 * Error class for Google API failures.
 *
 * @example
 * ```ts
 * try {
 *   await geocodeAddress('invalid');
 * } catch (error) {
 *   if (error instanceof GoogleApiError) {
 *     console.error(error.statusCode, error.message);
 *   }
 * }
 * ```
 */
export class GoogleApiError extends Error {
  /**
   * Creates a new API error instance.
   *
   * @param message - Human-readable error message
   * @param statusCode - HTTP status code, or `0` for API-level errors without an HTTP failure
   */
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = 'GoogleApiError';
  }
}
