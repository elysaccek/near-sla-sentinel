ALTER TABLE oracle_nodes ADD COLUMN near_public_key text UNIQUE;
ALTER TABLE oracle_challenges ADD COLUMN near_public_key text;

CREATE TABLE oracle_assignments (
  id uuid PRIMARY KEY,
  node_id uuid NOT NULL REFERENCES oracle_nodes(id),
  network text NOT NULL,
  contract text NOT NULL,
  sla_id text NOT NULL,
  assignment jsonb NOT NULL,
  signature text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (node_id, network, contract, sla_id)
);
CREATE INDEX oracle_assignments_by_node ON oracle_assignments (node_id, id);

CREATE TABLE oracle_node_requests (
  node_id uuid NOT NULL REFERENCES oracle_nodes(id),
  request_id uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (node_id, request_id)
);
CREATE INDEX oracle_node_requests_expiry ON oracle_node_requests (received_at);
