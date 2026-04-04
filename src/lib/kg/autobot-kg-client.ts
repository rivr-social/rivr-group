/**
 * Autobot KG Client — rivr-group
 *
 * Thin HTTP client wrapping the Autobot token-server KG API.
 * Group-scoped: default scope_type is "group".
 */

const AUTOBOT_KG_URL = process.env.AUTOBOT_KG_URL || "http://localhost:3000";
const AUTOBOT_KG_TOKEN = process.env.AUTOBOT_KG_TOKEN || "";

export type KgDoc = {
  id: number;
  title: string;
  doc_type: string;
  scope_type: string;
  scope_id: string;
  status: string;
  triple_count: number;
  content_hash: string | null;
  source_uri: string | null;
  ingested_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type KgTriple = {
  id: number;
  subject: string;
  subject_type: string;
  predicate: string;
  object: string;
  object_type: string;
  confidence: number;
  source_doc_title: string | null;
  extraction_method: string;
  created_at: string;
};

export type KgEntity = {
  id: number;
  name: string;
  entity_type: string;
  canonical_name: string;
};

export type IngestResult = {
  source: string;
  format: string;
  classification: string;
  interpretationNote: string;
  sessionsCreated: number;
  transcriptLinesWritten: number;
  regexTriplesExtracted: number;
  llmChunksQueued: number;
  suppressedTriples: number;
  errors: string[];
  docId?: number;
};

async function kgFetch(
  path: string,
  options?: RequestInit,
): Promise<Response> {
  const url = `${AUTOBOT_KG_URL}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options?.headers as Record<string, string> || {}),
  };
  if (AUTOBOT_KG_TOKEN) {
    headers["Authorization"] = `Bearer ${AUTOBOT_KG_TOKEN}`;
  }
  return fetch(url, { ...options, headers });
}

export async function createDoc(params: {
  title: string;
  doc_type?: string;
  scope_type: string;
  scope_id: string;
  content_hash?: string;
  source_uri?: string;
  metadata?: Record<string, unknown>;
}): Promise<KgDoc> {
  const res = await kgFetch("/api/kg/docs", {
    method: "POST",
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`KG createDoc failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function listDocs(
  scopeType: string,
  scopeId: string,
  status?: string,
): Promise<KgDoc[]> {
  const params = new URLSearchParams({ scope_type: scopeType, scope_id: scopeId });
  if (status) params.set("status", status);
  const res = await kgFetch(`/api/kg/docs?${params}`);
  if (!res.ok) throw new Error(`KG listDocs failed: ${res.status}`);
  return res.json();
}

export async function getDoc(docId: number): Promise<KgDoc & { live_triple_count: number }> {
  const res = await kgFetch(`/api/kg/docs/${docId}`);
  if (!res.ok) throw new Error(`KG getDoc failed: ${res.status}`);
  return res.json();
}

export async function ingestDoc(
  docId: number,
  content: string,
  format?: string,
  title?: string,
): Promise<IngestResult> {
  const res = await kgFetch(`/api/kg/docs/${docId}/ingest`, {
    method: "POST",
    body: JSON.stringify({ content, format, title }),
  });
  if (!res.ok) throw new Error(`KG ingestDoc failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function deleteDoc(docId: number): Promise<void> {
  const res = await kgFetch(`/api/kg/docs/${docId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`KG deleteDoc failed: ${res.status}`);
}

export async function queryScope(
  scopeType: string,
  scopeId: string,
  filters?: { entity?: string; predicate?: string; max_results?: number },
): Promise<{ triples: KgTriple[]; count: number }> {
  const res = await kgFetch("/api/kg/query", {
    method: "POST",
    body: JSON.stringify({ scope_type: scopeType, scope_id: scopeId, ...filters }),
  });
  if (!res.ok) throw new Error(`KG queryScope failed: ${res.status}`);
  return res.json();
}

export async function buildContext(
  scopeType: string,
  scopeId: string,
  maxChars?: number,
): Promise<{ context: string; length: number }> {
  const res = await kgFetch("/api/kg/context", {
    method: "POST",
    body: JSON.stringify({ scope_type: scopeType, scope_id: scopeId, max_chars: maxChars }),
  });
  if (!res.ok) throw new Error(`KG buildContext failed: ${res.status}`);
  return res.json();
}

export async function listEntities(
  scopeType?: string,
  scopeId?: string,
): Promise<KgEntity[]> {
  const params = new URLSearchParams();
  if (scopeType) params.set("scope_type", scopeType);
  if (scopeId) params.set("scope_id", scopeId);
  const res = await kgFetch(`/api/kg/entities?${params}`);
  if (!res.ok) throw new Error(`KG listEntities failed: ${res.status}`);
  return res.json();
}
