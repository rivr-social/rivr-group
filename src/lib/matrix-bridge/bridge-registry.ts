/**
 * Registry mapping messenger connector providers to their mautrix bridge.
 *
 * A bridge is "deployed" for this instance when its public provisioning URL
 * env var is set (e.g. `MAUTRIX_SIGNAL_URL`). Providers without a configured
 * bridge simply fall back to the Advanced token-paste path in the connectors
 * panel — the guided-login button only appears where a bridge is live.
 *
 * Non-messenger providers (google_*, notion, substack, luma, x) are NOT here;
 * they use direct API/OAuth, not Matrix bridges.
 */
import type { BridgeProvisioningConfig } from "./provisioning-client";

/** Connector providers that route through a mautrix bridge. */
export const BRIDGE_PROVIDERS = [
  "telegram",
  "whatsapp",
  "signal",
  "slack",
  "facebook",
  "instagram",
] as const;

export type BridgeProvider = (typeof BRIDGE_PROVIDERS)[number];

interface BridgeDefinition {
  provider: BridgeProvider;
  /** Env var holding the bridge's public provisioning base URL. */
  urlEnv: string;
  /** How the user proves identity, for UI copy. */
  loginKind: "qr" | "phone" | "token";
  /** Human hint shown at the top of the guided dialog. */
  hint: string;
}

const BRIDGE_DEFINITIONS: Record<BridgeProvider, BridgeDefinition> = {
  telegram: {
    provider: "telegram",
    urlEnv: "MAUTRIX_TELEGRAM_URL",
    loginKind: "phone",
    hint: "Enter your Telegram phone number, then the code Telegram sends you.",
  },
  whatsapp: {
    provider: "whatsapp",
    urlEnv: "MAUTRIX_WHATSAPP_URL",
    loginKind: "qr",
    hint: "Open WhatsApp on your phone → Settings → Linked Devices → Link a Device, then scan the code.",
  },
  signal: {
    provider: "signal",
    urlEnv: "MAUTRIX_SIGNAL_URL",
    loginKind: "qr",
    hint: "Open Signal on your phone → Settings → Linked Devices → +, then scan the code.",
  },
  slack: {
    provider: "slack",
    urlEnv: "MAUTRIX_SLACK_URL",
    loginKind: "token",
    hint: "Sign in to your Slack workspace when prompted.",
  },
  facebook: {
    provider: "facebook",
    urlEnv: "MAUTRIX_FACEBOOK_URL",
    loginKind: "qr",
    hint: "Sign in to Facebook Messenger when prompted.",
  },
  instagram: {
    provider: "instagram",
    urlEnv: "MAUTRIX_INSTAGRAM_URL",
    loginKind: "qr",
    hint: "Sign in to Instagram when prompted.",
  },
};

export function isBridgeProvider(provider: string): provider is BridgeProvider {
  return (BRIDGE_PROVIDERS as readonly string[]).includes(provider);
}

/** Returns the bridge login UI hint + kind for a provider (no env needed). */
export function getBridgeDefinition(provider: string): BridgeDefinition | null {
  return isBridgeProvider(provider) ? BRIDGE_DEFINITIONS[provider] : null;
}

/**
 * Resolves a provider's live bridge config from env, or null when no bridge is
 * deployed for it on this instance.
 */
export function getBridgeForProvider(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): (BridgeDefinition & { config: BridgeProvisioningConfig }) | null {
  const def = getBridgeDefinition(provider);
  if (!def) return null;
  const baseUrl = env[def.urlEnv]?.trim();
  if (!baseUrl) return null;
  return { ...def, config: { baseUrl } };
}

/** The messenger providers that have a bridge deployed on this instance. */
export function listDeployedBridgeProviders(env: NodeJS.ProcessEnv = process.env): BridgeProvider[] {
  return BRIDGE_PROVIDERS.filter((provider) => Boolean(env[BRIDGE_DEFINITIONS[provider].urlEnv]?.trim()));
}
