/**
 * File upload API route.
 *
 * Purpose:
 * Accepts authenticated multipart uploads, validates request constraints, enforces
 * per-user rate limits, and stores files through the shared storage abstraction.
 *
 * Key exports:
 * - `POST`: Uploads one or more files and returns storage metadata/URLs.
 *
 * Dependencies:
 * - Next.js route primitives (`NextRequest`, `NextResponse`)
 * - Session authentication (`auth`)
 * - Storage service and typed storage errors (`uploadFile`, `StorageError`,
 *   `FileSizeError`, `InvalidMimeTypeError`)
 * - Rate limiting utility (`rateLimit`)
 * - Shared HTTP status constants
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { uploadFile, StorageError, FileSizeError, InvalidMimeTypeError } from '@/lib/storage';
import { rateLimit } from '@/lib/rate-limit';
import type { BucketName } from '@/lib/storage';
import {
  STATUS_OK,
  STATUS_BAD_REQUEST,
  STATUS_UNAUTHORIZED,
  STATUS_TOO_MANY_REQUESTS,
  STATUS_PAYLOAD_TOO_LARGE,
  STATUS_UNSUPPORTED_MEDIA_TYPE,
  STATUS_INTERNAL_ERROR,
} from '@/lib/http-status';

// Limits
const MAX_FILES_PER_REQUEST = 10;
const UPLOAD_RATE_LIMIT = 20;
const UPLOAD_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/**
 * Uploads one or more files for an authenticated user.
 *
 * Security and business rules:
 * - Requires a valid authenticated session.
 * - Applies per-user rate limiting (`20` requests per `1` hour window).
 * - Rejects cross-site origins when `Origin` and `Host` headers do not match.
 * - Accepts at most `10` files per request.
 * - Optionally constrains uploads to known storage buckets.
 *
 * Error handling pattern:
 * - Validation/auth/rate-limit errors return early with specific HTTP status codes.
 * - Storage-layer typed errors are mapped to appropriate API responses.
 * - Unknown upload failures are normalized to generic internal-error responses.
 *
 * @param {NextRequest} request Multipart/form-data request with `file` and optional `bucket`.
 * @returns {Promise<NextResponse>} JSON response containing upload results or an error payload.
 * @throws {Error} Propagates unexpected framework/runtime failures outside explicit try/catch blocks.
 * @example
 * // POST /api/upload (multipart/form-data)
 * // fields: file=<binary>, bucket=uploads
 * // -> 200 { results: [...] }
 */
export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host) {
    try {
      const originHost = new URL(origin).host;
      // Basic same-origin guard to reduce CSRF-style cross-site upload attempts.
      if (originHost !== host) {
        return NextResponse.json(
          { error: "Cross-site uploads are not allowed." },
          { status: 403 }
        );
      }
    } catch {
      // Reject malformed Origin headers instead of processing ambiguous requests.
      return NextResponse.json(
        { error: "Invalid request origin." },
        { status: 403 }
      );
    }
  }

  // Authenticate the request
  const session = await auth();
  if (!session?.user?.id) {
    // Uploads are user-scoped for accountability and rate limiting.
    return NextResponse.json(
      { error: 'Authentication required' },
      { status: STATUS_UNAUTHORIZED }
    );
  }

  // Rate limit per authenticated user
  const limiter = await rateLimit(`upload:${session.user.id}`, UPLOAD_RATE_LIMIT, UPLOAD_WINDOW_MS);
  if (!limiter.success) {
    // `Retry-After` tells clients when the current throttle window resets.
    const retryAfterSec = Math.ceil(limiter.resetMs / 1000);
    return NextResponse.json(
      { error: 'Too many uploads. Please try again later.' },
      {
        status: STATUS_TOO_MANY_REQUESTS,
        headers: { 'Retry-After': String(retryAfterSec) },
      }
    );
  }

  let formData: FormData;
  try {
    // Next.js parses multipart/form-data here; non-multipart bodies throw.
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: 'Request body must be multipart/form-data' },
      { status: STATUS_BAD_REQUEST }
    );
  }

  // Extract optional bucket selection
  const VALID_BUCKETS: BucketName[] = ['uploads', 'avatars', 'exports'];
  const bucketField = formData.get('bucket');
  let targetBucket: BucketName | undefined;
  if (bucketField && typeof bucketField === 'string') {
    // Strict allow-list prevents writes to unapproved storage buckets.
    if (!VALID_BUCKETS.includes(bucketField as BucketName)) {
      return NextResponse.json(
        { error: `Invalid bucket "${bucketField}". Must be one of: ${VALID_BUCKETS.join(', ')}` },
        { status: STATUS_BAD_REQUEST }
      );
    }
    targetBucket = bucketField as BucketName;
  }

  // Extract files from form data
  const files = formData.getAll('file');
  if (files.length === 0) {
    return NextResponse.json(
      { error: 'No files provided. Include one or more files with the field name "file"' },
      { status: STATUS_BAD_REQUEST }
    );
  }

  if (files.length > MAX_FILES_PER_REQUEST) {
    return NextResponse.json(
      { error: `Too many files. Maximum ${MAX_FILES_PER_REQUEST} files per request` },
      { status: STATUS_BAD_REQUEST }
    );
  }

  // Validate that all entries are actual File objects
  const fileObjects: File[] = [];
  for (const entry of files) {
    // Defend against non-file form fields accidentally/maliciously sent as `file`.
    if (!(entry instanceof File)) {
      return NextResponse.json(
        { error: 'All "file" fields must be file uploads' },
        { status: STATUS_BAD_REQUEST }
      );
    }
    fileObjects.push(entry);
  }

  // Upload each file
  const results = [];
  for (const file of fileObjects) {
    // Convert browser File into Node.js Buffer for storage adapter compatibility.
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    try {
      const result = await uploadFile(buffer, file.name, file.type, targetBucket);
      results.push(result);
    } catch (error) {
      // Preserve actionable validation feedback from storage policy enforcement.
      if (error instanceof FileSizeError) {
        return NextResponse.json(
          { error: error.message, file: file.name },
          { status: STATUS_PAYLOAD_TOO_LARGE }
        );
      }
      if (error instanceof InvalidMimeTypeError) {
        return NextResponse.json(
          { error: error.message, file: file.name },
          { status: STATUS_UNSUPPORTED_MEDIA_TYPE }
        );
      }
      if (error instanceof StorageError) {
        // Surface storage-layer failure details while keeping response shape consistent.
        return NextResponse.json(
          { error: `Upload failed for ${file.name}: ${error.message}` },
          { status: STATUS_INTERNAL_ERROR }
        );
      }
      // Fallback for unexpected exceptions from dependencies/runtime.
      return NextResponse.json(
        { error: `Unexpected error uploading ${file.name}` },
        { status: STATUS_INTERNAL_ERROR }
      );
    }
  }

  return NextResponse.json({ results }, { status: STATUS_OK });
}
