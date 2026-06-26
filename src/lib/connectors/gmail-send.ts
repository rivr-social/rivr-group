/**
 * @fileoverview Gmail outbound send for the group connector lane
 * (platform-evolution Wave 5 T5.3 — "outbound send-by-group").
 *
 * Sends a single email AS the agent, using the Gmail REST `messages.send`
 * endpoint with the agent's stored access token (encrypted at rest, decrypted
 * via the shared {@link resolveGmailToken}). This is the deliberate-action
 * counterpart to the on-demand save lane: the caller (a group admin via
 * `/api/connectors`, or the agent's assistant) supplies an explicit
 * recipient/subject/body — nothing is sent autonomously.
 *
 * Direction: outbound only. There is NO inbound→Resource sync here (that lane is
 * the user-initiated single-item save in `gmail-save.ts`). RFC 2822 message
 * assembly is intentionally minimal (To / Subject / Content-Type + body); richer
 * MIME (attachments, CC/BCC threading) is out of scope for this slice.
 */
import { resolveGmailToken } from "@/lib/connectors/gmail-save";

const GMAIL_PROVIDER = "gmail" as const;
const GMAIL_SEND_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
/** Conservative cap so a single send can't ship an unbounded payload. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

/** Input for a single outbound Gmail send. */
export interface GmailSendInput {
  to: string;
  subject: string;
  body: string;
  /** When true, send `body` as `text/html`; otherwise `text/plain`. */
  html?: boolean;
}

/** Outcome of a single outbound Gmail send. */
export interface GmailSendResult {
  provider: "gmail";
  /** Gmail message id of the sent message. */
  messageId: string;
  /** Gmail thread id of the sent message. */
  threadId: string;
  to: string;
  subject: string;
}

interface GmailSendResponse {
  id?: string;
  threadId?: string;
}

/** Loose RFC 5322 sanity check — rejects header-injection and obviously bad input. */
function assertValidRecipient(to: string): void {
  if (!to || /[\r\n]/.test(to)) {
    throw new Error("A valid recipient email address is required.");
  }
  // Single-address, no display name, no header smuggling. Keep it strict.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    throw new Error(`"${to}" is not a valid email address.`);
  }
}

/** Strips CR/LF from a header value so it can't inject extra headers. */
function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/**
 * Assembles a minimal RFC 2822 message and encodes it as the base64url `raw`
 * payload Gmail's `messages.send` expects.
 */
export function buildRawMessage(input: GmailSendInput): string {
  assertValidRecipient(input.to);
  const subject = sanitizeHeader(input.subject ?? "");
  const contentType = input.html ? "text/html" : "text/plain";
  const body = input.body ?? "";
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    throw new Error("Email body exceeds the maximum allowed size.");
  }
  const headers = [
    `To: ${input.to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: ${contentType}; charset="UTF-8"`,
    "Content-Transfer-Encoding: 7bit",
  ];
  const mime = `${headers.join("\r\n")}\r\n\r\n${body}`;
  return Buffer.from(mime, "utf8").toString("base64url");
}

/**
 * Sends a single email as the agent via Gmail.
 *
 * @param targetAgentId - Agent whose Gmail connector sends the message.
 * @param input - Recipient, subject, body, and optional html flag.
 * @throws {Error} When no connector is configured, the recipient is invalid,
 *   the token expired (401), or the Gmail API otherwise rejects the request.
 */
export async function sendGmailMessage(
  targetAgentId: string,
  input: GmailSendInput,
): Promise<GmailSendResult> {
  const raw = buildRawMessage(input);
  const token = await resolveGmailToken(targetAgentId);

  const response = await fetch(GMAIL_SEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 401) {
    throw new Error("Gmail access expired. Reconnect the Gmail connector.");
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Gmail API error (${response.status}): ${detail.slice(0, 300)}`);
  }

  const sent = (await response.json()) as GmailSendResponse;
  return {
    provider: GMAIL_PROVIDER,
    messageId: sent.id ?? "",
    threadId: sent.threadId ?? "",
    to: input.to,
    subject: sanitizeHeader(input.subject ?? ""),
  };
}

/** Providers whose connector supports outbound email send. */
export const EMAIL_SEND_PROVIDERS = [GMAIL_PROVIDER] as const;

/**
 * Dispatches an outbound email send for the given provider. Currently only Gmail
 * is wired; other providers throw a clear "not supported" error.
 */
export async function runConnectorSendEmail(
  targetAgentId: string,
  provider: string,
  input: GmailSendInput,
): Promise<GmailSendResult> {
  if (provider === GMAIL_PROVIDER) {
    return sendGmailMessage(targetAgentId, input);
  }
  throw new Error(`Email send is not supported for the ${provider} connector.`);
}
