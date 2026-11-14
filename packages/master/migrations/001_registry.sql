CREATE TABLE oracle_invitations (
  id uuid PRIMARY KEY,
  digest bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE oracle_nodes (
  id uuid PRIMARY KEY,
  identity_key text NOT NULL UNIQUE,
  near_account text NOT NULL UNIQUE,
  invitation_id uuid NOT NULL UNIQUE REFERENCES oracle_invitations(id),
  metadata jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING_APPROVAL'
    CHECK (status IN ('PENDING_APPROVAL', 'ACTIVE', 'REJECTED', 'DISABLED', 'REVOKED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_heartbeat_at timestamptz
);
CREATE INDEX oracle_nodes_by_status ON oracle_nodes (status, id);

CREATE TABLE oracle_challenges (
  id uuid PRIMARY KEY,
  message text NOT NULL,
  invitation_id uuid NOT NULL REFERENCES oracle_invitations(id),
  node_id uuid NOT NULL,
  identity_key text NOT NULL,
  near_account text NOT NULL,
  metadata jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX oracle_challenges_expiry ON oracle_challenges (expires_at);

CREATE TABLE oracle_heartbeats (
  node_id uuid NOT NULL REFERENCES oracle_nodes(id),
  request_id uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reported_at timestamptz NOT NULL,
  health jsonb NOT NULL,
  PRIMARY KEY (node_id, request_id)
);
CREATE INDEX oracle_heartbeats_history ON oracle_heartbeats (node_id, received_at DESC, request_id DESC);

CREATE TABLE oracle_rate_limits (
  bucket text NOT NULL,
  window_start bigint NOT NULL,
  attempts integer NOT NULL,
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX oracle_rate_limits_expiry ON oracle_rate_limits (window_start);

CREATE TABLE oracle_audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor text NOT NULL,
  action text NOT NULL,
  subject uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
