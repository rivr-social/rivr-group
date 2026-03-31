/**
 * @module mapbox
 * @description Shared map configuration values and optional Mapbox token accessors.
 *
 * Purpose:
 * - Provide default viewport and container styles for map rendering.
 * - Expose token/configuration helpers for optional Mapbox-backed layers.
 *
 * Key exports:
 * - `DEFAULT_VIEWPORT`, `MAP_CONTAINER_STYLE`
 * - `getMapboxToken()`, `isMapboxConfigured()`
 *
 * Dependencies:
 * - `process.env.NEXT_PUBLIC_MAPBOX_TOKEN` for optional runtime token lookup.
 *
 * Configuration notes:
 * - OpenLayers with OpenStreetMap tiles works without a Mapbox token.
 * - Mapbox token is only required when enabling Mapbox-specific layers or services.
 */

/**
 * Default map camera position and zoom level used for first render.
 * Values represent longitude/latitude around Boulder, CO with city-level zoom.
 */
export const DEFAULT_VIEWPORT = {
  longitude: -105.2705,
  latitude: 40.015,
  zoom: 12,
} as const;

/**
 * Default map container CSS dimensions; intended to fill available parent space.
 */
export const MAP_CONTAINER_STYLE = {
  width: '100%',
  height: '100%',
} as const;

/**
 * Returns the Mapbox access token from the environment (optional).
 * OpenLayers uses OSM tiles by default and does not require a token.
 * A Mapbox token is only needed if you want to use Mapbox vector tile layers.
 *
 * @param _unused - This function does not accept parameters.
 * @returns The Mapbox token, or an empty string when unset
 * @throws {TypeError} Never intentionally thrown; runtime access is simple environment lookup.
 * @example
 * ```ts
 * const token = getMapboxToken();
 * ```
 */
export function getMapboxToken(): string {
  // Returning an empty string keeps token consumers simple without forcing null checks.
  return process.env.NEXT_PUBLIC_MAPBOX_TOKEN || '';
}

/**
 * Checks whether the Mapbox token is configured.
 * The map works without it (using OSM tiles), but Mapbox layers require it.
 *
 * @param _unused - This function does not accept parameters.
 * @returns `true` when `NEXT_PUBLIC_MAPBOX_TOKEN` is present
 * @throws {TypeError} Never intentionally thrown; runtime access is simple environment lookup.
 * @example
 * ```ts
 * if (isMapboxConfigured()) {
 *   // Enable optional Mapbox-specific layer controls.
 * }
 * ```
 */
export function isMapboxConfigured(): boolean {
  return !!process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
}
