/**
 * LiveKit server-side helpers for Virtual Meeting events.
 *
 * Wraps the LiveKit Server SDK for room creation, participant token
 * generation, per-participant audio track egress (the recording rail that
 * makes transcripts identity-correlated), and webhook verification.
 *
 * Configuration comes from LIVEKIT_URL / LIVEKIT_WS_URL / LIVEKIT_API_KEY /
 * LIVEKIT_API_SECRET; recording storage from MEETING_RECORDINGS_S3_*.
 * Both resolve to null when unset so callers can 503 cleanly.
 */

import {
  RoomServiceClient,
  AccessToken,
  EgressClient,
  DirectFileOutput,
  S3Upload,
  WebhookReceiver,
  type WebhookEvent,
} from "livekit-server-sdk";

import {
  ENV_LIVEKIT_URL,
  ENV_LIVEKIT_WS_URL,
  ENV_LIVEKIT_API_KEY,
  ENV_LIVEKIT_API_SECRET,
  ENV_RECORDINGS_S3_ENDPOINT,
  ENV_RECORDINGS_S3_ACCESS_KEY,
  ENV_RECORDINGS_S3_SECRET_KEY,
  ENV_RECORDINGS_S3_BUCKET,
  ENV_RECORDINGS_S3_REGION,
  TOKEN_TTL_SECONDS,
  DEFAULT_MAX_PARTICIPANTS,
  ROOM_EMPTY_TIMEOUT_SECONDS,
} from "./constants";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface LiveKitConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
}

export function getLiveKitConfig(): LiveKitConfig | null {
  const url = process.env[ENV_LIVEKIT_WS_URL] || process.env[ENV_LIVEKIT_URL];
  const apiKey = process.env[ENV_LIVEKIT_API_KEY];
  const apiSecret = process.env[ENV_LIVEKIT_API_SECRET];

  if (!url || !apiKey || !apiSecret) {
    return null;
  }

  return { url, apiKey, apiSecret };
}

export interface RecordingStorageConfig {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region: string;
}

export function getRecordingStorageConfig(): RecordingStorageConfig | null {
  const endpoint = process.env[ENV_RECORDINGS_S3_ENDPOINT]?.trim();
  const accessKey = process.env[ENV_RECORDINGS_S3_ACCESS_KEY]?.trim();
  const secretKey = process.env[ENV_RECORDINGS_S3_SECRET_KEY]?.trim();
  const bucket = process.env[ENV_RECORDINGS_S3_BUCKET]?.trim();
  const region = process.env[ENV_RECORDINGS_S3_REGION]?.trim() || "us-east-1";

  if (!endpoint || !accessKey || !secretKey || !bucket) {
    return null;
  }

  return { endpoint, accessKey, secretKey, bucket, region };
}

/** Recording is possible only when BOTH LiveKit and storage are configured. */
export function isMeetingRecordingConfigured(): boolean {
  return getLiveKitConfig() !== null && getRecordingStorageConfig() !== null;
}

// ---------------------------------------------------------------------------
// Client factories
// ---------------------------------------------------------------------------

/** LiveKit server APIs need an http(s) endpoint; accept wss/ws configs too. */
function apiBaseUrl(url: string): string {
  return url.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
}

export function createRoomService(config: LiveKitConfig): RoomServiceClient {
  return new RoomServiceClient(apiBaseUrl(config.url), config.apiKey, config.apiSecret);
}

export function createEgressClient(config: LiveKitConfig): EgressClient {
  return new EgressClient(apiBaseUrl(config.url), config.apiKey, config.apiSecret);
}

// ---------------------------------------------------------------------------
// Room management
// ---------------------------------------------------------------------------

export interface CreateRoomOptions {
  roomName: string;
  maxParticipants?: number;
  emptyTimeout?: number;
  metadata?: string;
}

export async function createRoom(
  config: LiveKitConfig,
  options: CreateRoomOptions,
) {
  const svc = createRoomService(config);
  return svc.createRoom({
    name: options.roomName,
    maxParticipants: options.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS,
    emptyTimeout: options.emptyTimeout ?? ROOM_EMPTY_TIMEOUT_SECONDS,
    metadata: options.metadata,
  });
}

export async function listParticipants(
  config: LiveKitConfig,
  roomName: string,
) {
  const svc = createRoomService(config);
  return svc.listParticipants(roomName);
}

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

export interface TokenOptions {
  roomName: string;
  identity: string;
  name?: string;
  canPublish?: boolean;
  canPublishData?: boolean;
  ttl?: number;
  metadata?: string;
}

export async function generateToken(
  config: LiveKitConfig,
  options: TokenOptions,
): Promise<string> {
  const token = new AccessToken(config.apiKey, config.apiSecret, {
    identity: options.identity,
    name: options.name || options.identity,
    ttl: options.ttl ?? TOKEN_TTL_SECONDS,
    metadata: options.metadata,
  });

  token.addGrant({
    room: options.roomName,
    roomJoin: true,
    canPublish: options.canPublish ?? true,
    canPublishData: options.canPublishData ?? true,
  });

  return await token.toJwt();
}

// ---------------------------------------------------------------------------
// Per-participant audio recording (track egress)
// ---------------------------------------------------------------------------

/**
 * Starts an audio track egress writing directly to S3-compatible storage.
 * One file per participant audio track — the foundation of the
 * identity-correlated transcript (speaker = the track's owner).
 *
 * Returns the egress info (with egressId) from LiveKit.
 */
export async function startTrackAudioEgress(
  config: LiveKitConfig,
  storage: RecordingStorageConfig,
  roomName: string,
  trackSid: string,
  fileKey: string,
) {
  const client = createEgressClient(config);
  const output = new DirectFileOutput({
    filepath: fileKey,
    output: {
      case: "s3",
      value: new S3Upload({
        endpoint: storage.endpoint,
        accessKey: storage.accessKey,
        secret: storage.secretKey,
        bucket: storage.bucket,
        region: storage.region,
        forcePathStyle: true,
      }),
    },
  });
  return client.startTrackEgress(roomName, output, trackSid);
}

export async function stopEgress(config: LiveKitConfig, egressId: string) {
  const client = createEgressClient(config);
  return client.stopEgress(egressId);
}

// ---------------------------------------------------------------------------
// Webhook verification
// ---------------------------------------------------------------------------

/**
 * Verifies and decodes a LiveKit webhook request. Throws when the
 * Authorization JWT does not verify against our API key/secret.
 */
export async function receiveWebhookEvent(
  config: LiveKitConfig,
  body: string,
  authorizationHeader: string | null,
): Promise<WebhookEvent> {
  const receiver = new WebhookReceiver(config.apiKey, config.apiSecret);
  return receiver.receive(body, authorizationHeader ?? undefined);
}
