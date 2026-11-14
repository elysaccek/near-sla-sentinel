import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { Assignment, SignedAssignment } from "../../../shared/oracle-protocol.ts";
import type { SignedFaultSchedule } from "../../../shared/fault-protocol.ts";
import type { EvidenceBundle, ProbeContext, ProbeObservation } from "../monitoring/evidence.ts";
import type { RegistrationStatus } from "./master-client.ts";

export function assignmentId(assignment: Assignment) {
  return [assignment.network, assignment.contract, assignment.sla_id].join(":");
}

export interface PendingTransaction {
  hash: string;
  signed: string;
}

interface TaskRow {
  envelope: string;
  evidence: string | null;
  pending: string | null;
  attempts: number;
  authorized: number;
  next_attempt_ms: number;
  phase: "scheduled" | "recorded" | "closed" | "blocked";
  last_error: string | null;
  transaction_hash: string | null;
}

export function openWorkerStore(directory: string) {
  const db = new DatabaseSync(join(directory, "worker.sqlite"), { timeout: 100 });
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (version !== 0 && version !== 1 && version !== 2 && version !== 3) throw new Error("Unsupported worker database version");
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS worker_state (name TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, envelope TEXT NOT NULL, evidence TEXT, pending TEXT,
        starts_at_ms INTEGER NOT NULL, ends_at_ms INTEGER NOT NULL, deadline_ms INTEGER NOT NULL,
        authorized INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_ms INTEGER NOT NULL DEFAULT 0,
        phase TEXT NOT NULL DEFAULT 'scheduled' CHECK (phase IN ('scheduled','recorded','closed','blocked')),
        last_error TEXT, transaction_hash TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS scheduled_tasks ON tasks (phase, deadline_ms, starts_at_ms);
      CREATE UNIQUE INDEX IF NOT EXISTS one_pending_vote ON tasks ((1))
        WHERE phase='scheduled' AND pending IS NOT NULL;
      CREATE TABLE IF NOT EXISTS observations (
        task_id TEXT NOT NULL REFERENCES tasks(id), slot INTEGER NOT NULL, probe TEXT,
        PRIMARY KEY (task_id, slot)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS probe_diagnostics (
        task_id TEXT NOT NULL, slot INTEGER NOT NULL, detail TEXT NOT NULL,
        PRIMARY KEY (task_id, slot),
        FOREIGN KEY (task_id, slot) REFERENCES observations(task_id, slot)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS probe_context (
        task_id TEXT NOT NULL, slot INTEGER NOT NULL, detail TEXT NOT NULL,
        PRIMARY KEY (task_id, slot),
        FOREIGN KEY (task_id, slot) REFERENCES observations(task_id, slot)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS recorded_evidence (
        sequence INTEGER PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id)
      ) STRICT;
      CREATE TRIGGER IF NOT EXISTS queue_recorded_evidence AFTER UPDATE OF phase ON tasks
        WHEN OLD.phase!='recorded' AND NEW.phase='recorded' AND NEW.evidence IS NOT NULL
        BEGIN INSERT INTO recorded_evidence (task_id) VALUES (NEW.id) ON CONFLICT DO NOTHING; END;
      CREATE TABLE IF NOT EXISTS fault_windows (
        id TEXT PRIMARY KEY, revision INTEGER NOT NULL, starts_at_ms INTEGER NOT NULL, ends_at_ms INTEGER NOT NULL,
        detected_at_ms INTEGER NOT NULL, closed_at_ms INTEGER, reason TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_fault_window ON fault_windows ((1)) WHERE closed_at_ms IS NULL;
    `);
    if (version < 3) db.exec(`INSERT INTO recorded_evidence (task_id)
      SELECT id FROM tasks WHERE phase='recorded' AND evidence IS NOT NULL ON CONFLICT DO NOTHING;`);
    db.exec("PRAGMA user_version = 3; COMMIT;");
  } catch (error) {
    db.close();
    throw error;
  }

  function putState(name: string, value: string) {
    db.prepare("INSERT INTO worker_state VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value=excluded.value").run(name, value);
  }
  function getState(name: string) {
    return (db.prepare("SELECT value FROM worker_state WHERE name=?").get(name) as { value: string } | undefined)?.value;
  }
  function getTask(id: string) {
    const row = db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as unknown as TaskRow | undefined;
    if (!row) throw new Error("Unknown local assignment");
    return {
      envelope: JSON.parse(row.envelope) as unknown,
      evidence: row.evidence ? JSON.parse(row.evidence) as EvidenceBundle : undefined,
      pending: row.pending ? JSON.parse(row.pending) as PendingTransaction : undefined,
      attempts: row.attempts, authorized: row.authorized === 1, phase: row.phase, transactionHash: row.transaction_hash,
    };
  }
  function finishObservation(id: string, observation: ProbeObservation) {
    const result = db.prepare("UPDATE observations SET probe=? WHERE task_id=? AND slot=? AND probe IS NULL")
      .run(JSON.stringify(observation), id, observation.slot);
    if (!result.changes) throw new Error("Observation was already written");
  }
  return {
    close: () => db.close(),
    registration: () => getState("registration") as RegistrationStatus | undefined,
    setRegistration: (status: RegistrationStatus) => putState("registration", status),
    setLastMeasurement(time: number) {
      db.prepare(`INSERT INTO worker_state VALUES ('last_measurement', ?)
        ON CONFLICT (name) DO UPDATE SET value=excluded.value
        WHERE CAST(excluded.value AS INTEGER) > CAST(worker_state.value AS INTEGER)`).run(String(time));
    },
    lastMeasurement: () => getState("last_measurement"),
    faultSchedule() {
      const raw = getState("fault_schedule");
      return raw === undefined ? undefined : JSON.parse(raw) as unknown;
    },
    saveFaultSchedule(envelope: SignedFaultSchedule) {
      putState("fault_schedule", JSON.stringify(envelope));
    },
    openFaultWindow() {
      return db.prepare("SELECT id FROM fault_windows WHERE closed_at_ms IS NULL LIMIT 1").get()?.id as string | undefined;
    },
    startFaultWindow(id: string, revision: number, start: number, end: number, now: number, reason: string) {
      return db.prepare(`INSERT INTO fault_windows (id, revision, starts_at_ms, ends_at_ms, detected_at_ms, reason)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`).run(id, revision, start, end, now, reason).changes === 1;
    },
    finishFaultWindow(id: string, now: number) {
      return db.prepare("UPDATE fault_windows SET closed_at_ms=MAX(?, detected_at_ms) WHERE id=? AND closed_at_ms IS NULL")
        .run(now, id).changes === 1;
    },
    getTask,
    saveAssignment(envelope: SignedAssignment) {
      const { assignment } = envelope;
      const id = assignmentId(assignment);
      const data = JSON.stringify(envelope);
      const { changes } = db.prepare(`INSERT INTO tasks (id, envelope, starts_at_ms, ends_at_ms, deadline_ms)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`).run(
        id, data, Number(assignment.policy.starts_at_ms), Number(assignment.policy.ends_at_ms), Number(assignment.policy.reporting_deadline_ms),
      );
      if (changes) return true;
      const old = getTask(id).envelope as SignedAssignment;
      if (JSON.stringify(old.assignment) !== JSON.stringify(assignment)) throw new Error("Cached assignment policy cannot be replaced");
      // A new signature can be delivered after an explicit Master key rotation.
      db.prepare("UPDATE tasks SET envelope=? WHERE id=? AND envelope<>?").run(data, id, data);
      return false;
    },
    awaitingAuthorization(now: number) {
      return db.prepare(`SELECT id FROM tasks WHERE phase='scheduled' AND authorized=0 AND next_attempt_ms<=?
        AND starts_at_ms<=? ORDER BY CASE WHEN ends_at_ms>? THEN 0 ELSE 1 END, starts_at_ms, id LIMIT 8`)
        .all(now, now + 60_000, now).map((row) => String(row.id));
    },
    setAuthorized(id: string) {
      db.prepare("UPDATE tasks SET authorized=1, attempts=0, next_attempt_ms=0, last_error=NULL WHERE id=? AND phase='scheduled'").run(id);
    },
    measuring(now: number) {
      return db.prepare(`SELECT id FROM tasks WHERE phase='scheduled' AND authorized=1 AND starts_at_ms<=? AND ends_at_ms>?
        ORDER BY starts_at_ms, id`).all(now, now).map((row) => String(row.id));
    },
    reportable(now: number, measuring: ReadonlySet<string>) {
      return db.prepare(`SELECT id FROM tasks WHERE phase='scheduled' AND authorized=1 AND next_attempt_ms<=?
        AND (pending IS NOT NULL OR (ends_at_ms<=? AND NOT EXISTS
          (SELECT 1 FROM tasks WHERE phase='scheduled' AND pending IS NOT NULL)))
        ORDER BY deadline_ms, id LIMIT 17`).all(now, now)
        .map(({ id }) => String(id)).find((id) => !measuring.has(id));
    },
    activeCount() {
      return Number(db.prepare("SELECT count(*) AS count FROM tasks WHERE phase='scheduled'").get()?.count);
    },
    pendingCount() {
      return Number(db.prepare("SELECT count(*) AS count FROM tasks WHERE phase='scheduled' AND pending IS NOT NULL").get()?.count);
    },
    setNextCheck(id: string, next: number) {
      db.prepare("UPDATE tasks SET next_attempt_ms=? WHERE id=? AND phase='scheduled'").run(next, id);
    },
    observations(id: string) {
      return db.prepare("SELECT probe FROM observations WHERE task_id=? AND probe IS NOT NULL ORDER BY slot")
        .all(id).map(({ probe }) => JSON.parse(String(probe)) as ProbeObservation);
    },
    probeContext(id: string) {
      return db.prepare("SELECT detail FROM probe_context WHERE task_id=? ORDER BY slot")
        .all(id).map(({ detail }) => JSON.parse(String(detail)) as ProbeContext);
    },
    claimSlot(id: string, slot: number) {
      return db.prepare("INSERT INTO observations VALUES (?, ?, NULL) ON CONFLICT DO NOTHING").run(id, slot).changes === 1;
    },
    finishSlot(id: string, observation: ProbeObservation, context?: ProbeContext) {
      if (!context) {
        finishObservation(id, observation);
        return;
      }
      if (context.slot !== observation.slot) throw new Error("Probe diagnostics belong to a different slot");
      db.exec("BEGIN IMMEDIATE");
      try {
        finishObservation(id, observation);
        db.prepare("INSERT INTO probe_context VALUES (?, ?, ?)").run(id, observation.slot, JSON.stringify(context));
        if (context.diagnostic) {
          db.prepare("INSERT INTO probe_diagnostics VALUES (?, ?, ?)").run(id, observation.slot, context.diagnostic);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    saveEvidence(id: string, evidence: EvidenceBundle) {
      db.prepare("UPDATE tasks SET evidence=? WHERE id=? AND evidence IS NULL").run(JSON.stringify(evidence), id);
      return getTask(id).evidence!;
    },
    recordedEvidence(after: number) {
      return db.prepare(`SELECT sequence, evidence FROM recorded_evidence JOIN tasks ON tasks.id=task_id
        WHERE sequence>? ORDER BY sequence LIMIT 16`).all(after)
        .map(({ sequence, evidence }) => ({ sequence: Number(sequence), evidence: String(evidence) }));
    },
    savePending(id: string, candidate: PendingTransaction) {
      db.prepare("UPDATE tasks SET pending=? WHERE id=? AND pending IS NULL AND phase='scheduled'").run(JSON.stringify(candidate), id);
      const { pending } = getTask(id);
      if (!pending) throw new Error("Transaction could not be persisted");
      return pending;
    },
    clearPending(id: string, hash: string) {
      db.prepare("UPDATE tasks SET pending=NULL WHERE id=? AND json_extract(pending,'$.hash')=?").run(id, hash);
    },
    retry(id: string, next: number, reason: string) {
      db.prepare("UPDATE tasks SET attempts=attempts+1, next_attempt_ms=?, last_error=? WHERE id=? AND phase='scheduled'")
        .run(next, reason, id);
    },
    finish(id: string, phase: "recorded" | "closed" | "blocked", error: string | null, hash: string | null = null) {
      db.prepare("UPDATE tasks SET phase=?, last_error=?, transaction_hash=? WHERE id=? AND phase='scheduled'")
        .run(phase, error, hash, id);
    },
    summary() {
      return {
        registration: getState("registration") ?? null,
        last_measurement_ms: getState("last_measurement") ?? null,
        recent_diagnostics: db.prepare(`SELECT task_id, slot, detail FROM probe_diagnostics
          ORDER BY rowid DESC LIMIT 20`).all(),
        recent_faults: db.prepare(`SELECT revision, starts_at_ms, ends_at_ms, detected_at_ms, closed_at_ms, reason FROM fault_windows
          ORDER BY detected_at_ms DESC LIMIT 20`).all(),
        tasks: db.prepare(`SELECT id, phase, authorized, attempts, last_error, transaction_hash, deadline_ms FROM tasks
          ORDER BY deadline_ms DESC, id LIMIT 100`).all()
          .map(({ authorized, ...task }) => ({ ...task, authorized: authorized === 1 })),
      };
    },
  };
}

export function lockWorker(directory: string) {
  const lock = new DatabaseSync(join(directory, "worker-lock.sqlite"));
  try {
    lock.exec("BEGIN EXCLUSIVE");
  } catch {
    lock.close();
    throw new Error("Worker state is in use by another running scheduler");
  }
  return () => lock.close();
}

export type WorkerStore = ReturnType<typeof openWorkerStore>;
