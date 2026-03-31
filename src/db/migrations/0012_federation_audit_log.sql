-- Federation audit log table for tracking all federation operations
CREATE TABLE IF NOT EXISTS federation_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  node_id uuid REFERENCES nodes(id),
  peer_node_id uuid REFERENCES nodes(id),
  federation_event_id uuid REFERENCES federation_events(id),
  actor_id uuid,
  status text NOT NULL,
  detail jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS federation_audit_log_event_type_idx ON federation_audit_log(event_type);
CREATE INDEX IF NOT EXISTS federation_audit_log_node_id_idx ON federation_audit_log(node_id);
CREATE INDEX IF NOT EXISTS federation_audit_log_created_at_idx ON federation_audit_log(created_at);
CREATE INDEX IF NOT EXISTS federation_audit_log_status_idx ON federation_audit_log(status);
