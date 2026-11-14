CREATE TABLE oracle_fault_schedules (
  node_id uuid NOT NULL REFERENCES oracle_nodes(id),
  network text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  schedule jsonb,
  signature text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (node_id, network, revision)
);
