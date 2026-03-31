/**
 * HTTP status constants shared across API handlers and service layers.
 *
 * Purpose:
 * - Prevent "magic number" status codes throughout the codebase.
 * - Keep server/client error mapping consistent.
 *
 * Key exports:
 * - 2xx success constants (`STATUS_OK`, `STATUS_CREATED`, `STATUS_NO_CONTENT`)
 * - 4xx client error constants (validation/auth/rate-limit/media errors)
 * - 5xx server error constants (`STATUS_INTERNAL_ERROR`)
 *
 * Dependencies:
 * - None (pure constants module).
 */

// 2xx — Success
/** Standard successful response status for read/query operations. */
export const STATUS_OK = 200;
/** Resource created successfully (typically used for POST create endpoints). */
export const STATUS_CREATED = 201;
/** Request succeeded and intentionally returns no response body. */
export const STATUS_NO_CONTENT = 204;

// 4xx — Client errors
/** Request payload/query is invalid or malformed. */
export const STATUS_BAD_REQUEST = 400;
/** Authentication is required or credentials are invalid. */
export const STATUS_UNAUTHORIZED = 401;
/** Authenticated user lacks permission for the requested action. */
export const STATUS_FORBIDDEN = 403;
/** Requested resource does not exist or is not visible to the caller. */
export const STATUS_NOT_FOUND = 404;
/** Resource previously existed but has been permanently removed. */
export const STATUS_GONE = 410;
/** Request body exceeds configured upload or payload limits. */
export const STATUS_PAYLOAD_TOO_LARGE = 413;
/** Request content type is not accepted by the endpoint. */
export const STATUS_UNSUPPORTED_MEDIA_TYPE = 415;
/** Caller exceeded per-identity or per-IP request limits. */
export const STATUS_TOO_MANY_REQUESTS = 429;

// 5xx — Server errors
/** Unhandled server failure for unexpected runtime/storage/dependency errors. */
export const STATUS_INTERNAL_ERROR = 500;
