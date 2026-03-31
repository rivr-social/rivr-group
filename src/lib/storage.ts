/**
 * MinIO/S3 storage utilities for validating and uploading application files.
 *
 * Purpose:
 * - Provide a single upload path with file-size and MIME-type validation.
 * - Encapsulate MinIO bucket resolution and public URL generation.
 * - Expose reset hooks for deterministic test behavior.
 *
 * Key exports:
 * - Upload API (`uploadFile`, `uploadFiles`) and upload result contract.
 * - Validation-related constants (`MAX_FILE_SIZE`, `ALLOWED_MIME_TYPES`).
 * - Storage-specific error types for granular error handling.
 *
 * Dependencies:
 * - `@aws-sdk/client-s3` for S3-compatible object uploads.
 * - `getEnv` for strongly-validated runtime configuration.
 */
import {
  S3Client,
  PutObjectCommand,
  PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import { getEnv } from './env';

// Storage constants
/** Logical bucket aliases supported by this module. */
export type BucketName = 'uploads' | 'avatars' | 'exports';

/** Maps logical bucket names to their backing environment variable keys. */
const BUCKET_ENV_MAP: Record<BucketName, string> = {
  uploads: 'MINIO_BUCKET_UPLOADS',
  avatars: 'MINIO_BUCKET_AVATARS',
  exports: 'MINIO_BUCKET_EXPORTS',
};

/** Default target bucket when a caller does not specify one explicitly. */
const DEFAULT_BUCKET: BucketName = 'uploads';

/** Maximum accepted upload size in bytes (10MB). */
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
/** Image MIME types permitted by upload validation. */
export const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
];
/** Full MIME type allowlist accepted by upload validation. */
export const ALLOWED_MIME_TYPES = [
  ...ALLOWED_IMAGE_TYPES,
  'application/pdf',
  'text/csv',
  'application/json',
  'model/gltf-binary',
];

/**
 * Resolves a logical bucket name to its configured value from environment
 */
function resolveBucket(bucket?: BucketName): string {
  const envKey = BUCKET_ENV_MAP[bucket ?? DEFAULT_BUCKET];
  return getEnv(envKey as Parameters<typeof getEnv>[0]);
}

// Error types
/** Base storage error used to preserve root-cause context. */
export class StorageError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'StorageError';
  }
}

/** Error thrown when upload payload exceeds configured size limits. */
export class FileSizeError extends StorageError {
  constructor(size: number, maxSize: number) {
    super(`File size ${size} bytes exceeds maximum allowed size of ${maxSize} bytes`);
    this.name = 'FileSizeError';
  }
}

/** Error thrown when a file MIME type is outside the module allowlist. */
export class InvalidMimeTypeError extends StorageError {
  constructor(mimeType: string, allowedTypes: string[]) {
    super(`MIME type ${mimeType} is not allowed. Allowed types: ${allowedTypes.join(', ')}`);
    this.name = 'InvalidMimeTypeError';
  }
}

// S3 Client configuration
let s3Client: S3Client | null = null;

/**
 * Gets or creates the S3Client instance configured for MinIO
 * @returns Configured S3Client instance
 */
function getS3Client(): S3Client {
  if (!s3Client) {
    const endpoint = getEnv('MINIO_ENDPOINT');
    const port = getEnv('MINIO_PORT');
    const accessKeyId = getEnv('MINIO_ACCESS_KEY');
    const secretAccessKey = getEnv('MINIO_SECRET_KEY');
    const useSSL = getEnv('MINIO_USE_SSL') === 'true';

    const protocol = useSSL ? 'https' : 'http';
    const endpointUrl = `${protocol}://${endpoint}:${port}`;

    s3Client = new S3Client({
      endpoint: endpointUrl,
      region: 'us-east-1', // MinIO requires a region but ignores it
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
      forcePathStyle: true, // Required for MinIO compatibility
    });
  }

  return s3Client;
}

/**
 * Generates a unique storage key with timestamp
 * @param filename - Original filename
 * @returns Unique storage key
 */
function generateStorageKey(filename: string): string {
  const timestamp = Date.now();
  const randomSuffix = Math.random().toString(36).substring(2, 15);
  // Sanitize path fragments so user-supplied names cannot inject object key delimiters.
  const sanitizedFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `uploads/${timestamp}-${randomSuffix}-${sanitizedFilename}`;
}

/**
 * Validates file size
 * @param buffer - File buffer
 * @throws FileSizeError if file exceeds maximum size
 */
function validateFileSize(buffer: Buffer): void {
  if (buffer.length > MAX_FILE_SIZE) {
    throw new FileSizeError(buffer.length, MAX_FILE_SIZE);
  }
}

/**
 * Validates MIME type
 * @param mimeType - MIME type to validate
 * @throws InvalidMimeTypeError if MIME type is not allowed
 */
function validateMimeType(mimeType: string): void {
  if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
    // Allowlist enforcement prevents arbitrary binary uploads through this path.
    throw new InvalidMimeTypeError(mimeType, ALLOWED_MIME_TYPES);
  }
}

// ─── Magic Byte Validation ────────────────────────────────────────────────────

/** Known file signatures (magic bytes) for content-type verification. */
const MAGIC_SIGNATURES: ReadonlyArray<{ mime: string; bytes: number[] }> = [
  { mime: 'image/jpeg', bytes: [0xFF, 0xD8, 0xFF] },
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4E, 0x47] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46] },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
];

/** WebP has a split signature: starts with RIFF, then WEBP at offset 8. */
const WEBP_RIFF_HEADER = [0x52, 0x49, 0x46, 0x46];
const WEBP_MARKER = [0x57, 0x45, 0x42, 0x50];

/**
 * Detect MIME type from the leading bytes of a buffer.
 * Returns `null` when the signature is not recognized.
 */
function detectMimeFromBytes(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;

  // Check WebP (RIFF....WEBP)
  if (
    WEBP_RIFF_HEADER.every((b, i) => buffer[i] === b) &&
    WEBP_MARKER.every((b, i) => buffer[i + 8] === b)
  ) {
    return 'image/webp';
  }

  for (const sig of MAGIC_SIGNATURES) {
    if (sig.bytes.every((b, i) => buffer[i] === b)) {
      return sig.mime;
    }
  }

  return null;
}

/** Error thrown when magic bytes contradict the claimed MIME type. */
export class MagicByteMismatchError extends StorageError {
  constructor(claimed: string, detected: string) {
    super(
      `Magic bytes indicate ${detected} but caller claimed ${claimed}. ` +
      `Upload rejected to prevent content-type spoofing.`
    );
    this.name = 'MagicByteMismatchError';
  }
}

/**
 * Validates that a buffer's magic bytes are consistent with the claimed MIME type.
 * If the file type cannot be detected from bytes (e.g. CSV, JSON, GLB), the check
 * is skipped — those types have no reliable magic byte signature.
 *
 * @throws MagicByteMismatchError when detected type contradicts the claim.
 */
function validateMagicBytes(buffer: Buffer, claimedMime: string): void {
  const detected = detectMimeFromBytes(buffer);
  if (detected && detected !== claimedMime) {
    throw new MagicByteMismatchError(claimedMime, detected);
  }
}

/**
 * Generates public URL for uploaded file
 * @param key - Storage key
 * @param bucketValue - Resolved bucket name
 * @returns Public URL
 */
function generatePublicUrl(key: string, bucketValue: string): string {
  const explicitPublicBase =
    process.env.ASSET_PUBLIC_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_MINIO_URL?.trim();
  if (explicitPublicBase) {
    return `${explicitPublicBase.replace(/\/+$/, '')}/${bucketValue}/${key}`;
  }

  const publicDomain = process.env.NEXT_PUBLIC_DOMAIN?.trim();
  if (publicDomain) {
    return `https://s3.${publicDomain}/${bucketValue}/${key}`;
  }

  const endpoint = getEnv('MINIO_ENDPOINT');
  const port = getEnv('MINIO_PORT');
  const useSSL = getEnv('MINIO_USE_SSL') === 'true';

  const protocol = useSSL ? 'https' : 'http';
  return `${protocol}://${endpoint}:${port}/${bucketValue}/${key}`;
}

export interface UploadResult {
  /** Object key assigned in storage. */
  key: string;
  /** Publicly resolvable URL for the uploaded object. */
  url: string;
  /** Resolved bucket name used for the upload. */
  bucket: string;
  /** Uploaded file size in bytes. */
  size: number;
  /** Caller-specified MIME type used during upload validation. */
  mimeType: string;
  /** Upload completion timestamp (epoch milliseconds). */
  timestamp: number;
}

/**
 * Uploads a file to MinIO storage
 * @param buffer - File buffer to upload
 * @param filename - Original filename
 * @param mimeType - MIME type of the file
 * @param targetBucket - Which bucket to upload to (defaults to 'uploads')
 * @returns Upload result with public URL
 * @throws StorageError if upload fails
 * @throws FileSizeError if file is too large
 * @throws InvalidMimeTypeError if MIME type is not allowed
 * @example
 * const result = await uploadFile(buffer, "avatar.png", "image/png", "avatars");
 */
export async function uploadFile(
  buffer: Buffer,
  filename: string,
  mimeType: string,
  targetBucket?: BucketName
): Promise<UploadResult> {
  try {
    // Validate before network I/O so rejected uploads fail fast and cheaply.
    validateFileSize(buffer);
    validateMimeType(mimeType);
    validateMagicBytes(buffer, mimeType);

    // Key generation uses timestamp + random suffix to reduce collision risk.
    const key = generateStorageKey(filename);
    const bucket = resolveBucket(targetBucket);

    // Prepare upload command
    const params: PutObjectCommandInput = {
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
      ContentLength: buffer.length,
    };

    // Upload uses S3-compatible API against MinIO endpoint.
    const client = getS3Client();
    const command = new PutObjectCommand(params);
    await client.send(command);

    // Public URL is deterministic and mirrors configured endpoint/bucket.
    const url = generatePublicUrl(key, bucket);

    return {
      key,
      url,
      bucket,
      size: buffer.length,
      mimeType,
      timestamp: Date.now(),
    };
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }
    throw new StorageError('Failed to upload file to storage', error);
  }
}

/**
 * Uploads multiple files in parallel
 * @param files - Array of files to upload
 * @param targetBucket - Which bucket to upload to (defaults to 'uploads')
 * @returns Array of upload results
 * @throws StorageError if any upload fails
 * @example
 * const uploads = await uploadFiles([{ buffer, filename: "doc.pdf", mimeType: "application/pdf" }], "uploads");
 */
export async function uploadFiles(
  files: Array<{ buffer: Buffer; filename: string; mimeType: string }>,
  targetBucket?: BucketName
): Promise<UploadResult[]> {
  const uploadPromises = files.map((file) =>
    uploadFile(file.buffer, file.filename, file.mimeType, targetBucket)
  );

  try {
    return await Promise.all(uploadPromises);
  } catch (error) {
    throw new StorageError('Failed to upload one or more files', error);
  }
}

/**
 * Resets the S3 client (useful for testing)
 * @param {void} _unused - No arguments are accepted.
 * @returns {void} Nothing.
 * @throws {never} This helper does not intentionally throw.
 * @example
 * resetS3Client();
 */
export function resetS3Client(): void {
  s3Client = null;
}
