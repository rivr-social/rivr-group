/**
 * Provider catalog for the unified Connectors surface.
 *
 * Sync backend by provider class (the `/api/connectors` route only stores
 * credentials and runs a one-shot connectivity `test`; it does NOT run any
 * background sync loop here):
 *  - Messenger-class providers — telegram, whatsapp, signal, slack, facebook,
 *    instagram — are intended to SYNC via mautrix bridges on RIVR's existing
 *    Matrix/Synapse infra, NOT bespoke per-provider polling. Wire their
 *    background sync into the bridge layer, not into this module.
 *  - Non-messenger providers — google_drive, google_calendar, gmail, notion,
 *    substack, luma, x — use direct API/OAuth.
 */
export const CONNECTOR_CATALOG = [
  { id: "google_drive", label: "Google Drive", credentialLabel: "OAuth access token", refreshCredentialLabel: "OAuth refresh token", accountLabel: "Google account email", testUrl: "https://www.googleapis.com/drive/v3/about?fields=user" },
  { id: "google_calendar", label: "Google Calendar", credentialLabel: "OAuth access token", refreshCredentialLabel: "OAuth refresh token", accountLabel: "Google account email", testUrl: "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1" },
  { id: "gmail", label: "Gmail", credentialLabel: "OAuth access token", refreshCredentialLabel: "OAuth refresh token", accountLabel: "Gmail address", testUrl: "https://gmail.googleapis.com/gmail/v1/users/me/profile" },
  { id: "notion", label: "Notion", credentialLabel: "Integration token", accountLabel: "Workspace name", testUrl: "https://api.notion.com/v1/users/me" },
  { id: "telegram", label: "Telegram", credentialLabel: "Bot token", accountLabel: "Bot or chat label", testUrl: "https://api.telegram.org/bot{token}/getMe" },
  { id: "whatsapp", label: "WhatsApp", credentialLabel: "Cloud API access token", accountLabel: "Phone number ID", testUrl: "https://graph.facebook.com/v21.0/{account}" },
  { id: "signal", label: "Signal", credentialLabel: "Bridge access token", accountLabel: "Signal bridge URL", testUrl: "{account}/v1/about", supportsTest: false },
  { id: "slack", label: "Slack", credentialLabel: "Bot or user token", accountLabel: "Workspace name", testUrl: "https://slack.com/api/auth.test" },
  { id: "facebook", label: "Facebook", credentialLabel: "Graph API access token", accountLabel: "Page or profile ID", testUrl: "https://graph.facebook.com/v21.0/me?fields=id,name" },
  { id: "instagram", label: "Instagram", credentialLabel: "Graph API access token", accountLabel: "Instagram account ID", testUrl: "https://graph.facebook.com/v21.0/me?fields=id,username" },
  { id: "substack", label: "Substack", credentialLabel: null, accountLabel: "Publication URL", testUrl: "{account}/feed" },
  { id: "luma", label: "Luma", credentialLabel: "API key", accountLabel: "Calendar name", testUrl: "https://public-api.luma.com/v1/users/get-self" },
  { id: "x", label: "X", credentialLabel: "Bearer token", accountLabel: "X handle", testUrl: "https://api.x.com/2/users/me" },
] as const;

export type ConnectorProvider = (typeof CONNECTOR_CATALOG)[number]["id"];

export function getConnectorDefinition(provider: string) {
  return CONNECTOR_CATALOG.find((definition) => definition.id === provider);
}
