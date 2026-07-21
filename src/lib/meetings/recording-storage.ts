/**
 * Meeting-recording storage reader.
 *
 * Downloads egress-written track recordings from the S3-compatible
 * recordings bucket (MEETING_RECORDINGS_S3_*) so the webhook processor
 * can feed them to transcription. Write-side never happens here — the
 * LiveKit Egress service uploads directly using the same credentials.
 */

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  getRecordingStorageConfig,
  type RecordingStorageConfig,
} from "./livekit";

let cachedClient: S3Client | null = null;
let cachedEndpoint: string | null = null;

function getRecordingsClient(config: RecordingStorageConfig): S3Client {
  if (!cachedClient || cachedEndpoint !== config.endpoint) {
    cachedClient = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
      forcePathStyle: true,
    });
    cachedEndpoint = config.endpoint;
  }
  return cachedClient;
}

export class RecordingDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordingDownloadError";
  }
}

/**
 * Downloads a recording object and wraps it as a File for the
 * transcription client. Throws {@link RecordingDownloadError} on failure.
 */
export async function downloadRecordingAsFile(fileKey: string): Promise<File> {
  const config = getRecordingStorageConfig();
  if (!config) {
    throw new RecordingDownloadError(
      "Meeting recording storage is not configured (MEETING_RECORDINGS_S3_*).",
    );
  }

  try {
    const client = getRecordingsClient(config);
    const result = await client.send(
      new GetObjectCommand({ Bucket: config.bucket, Key: fileKey }),
    );
    if (!result.Body) {
      throw new RecordingDownloadError(`Recording ${fileKey} has no body.`);
    }
    const bytes = await result.Body.transformToByteArray();
    // Copy into a fresh ArrayBuffer — the SDK's Uint8Array may be backed by
    // a SharedArrayBuffer, which BlobPart typing rejects.
    const arrayBuffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(arrayBuffer).set(bytes);
    const fileName = fileKey.split("/").pop() || "meeting-track.ogg";
    const mimeType = fileName.endsWith(".ogg") ? "audio/ogg" : "audio/webm";
    return new File([arrayBuffer], fileName, { type: mimeType });
  } catch (error) {
    if (error instanceof RecordingDownloadError) throw error;
    throw new RecordingDownloadError(
      error instanceof Error
        ? `Failed to download recording ${fileKey}: ${error.message}`
        : `Failed to download recording ${fileKey}`,
    );
  }
}
