import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { WORKFLOW_STEPS, type WorkflowStep } from '@topic2md/shared';

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    model TEXT,
    status TEXT NOT NULL,
    error_message TEXT,
    location TEXT,
    source_run_id TEXT,
    source_stage TEXT,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    duration_ms INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS run_stages (
    run_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, stage),
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC)`,
  `CREATE TABLE IF NOT EXISTS image_embeddings (
    url TEXT NOT NULL,
    model_version TEXT NOT NULL,
    embedding BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (url, model_version)
  )`,
];

const DEFAULT_URL = 'sqlite:./data.db';

export type { DatabaseType };

export function openDatabase(url: string = process.env.DATABASE_URL ?? DEFAULT_URL): DatabaseType {
  const path = url.replace(/^sqlite:(\/\/)?/, '');
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  for (const sql of MIGRATIONS) db.exec(sql);
  ensureRunsColumn(db, 'background', 'TEXT');
  return db;
}

function ensureRunsColumn(db: DatabaseType, column: string, type: string): void {
  const rows = db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[];
  if (rows.some((r) => r.name === column)) return;
  db.exec(`ALTER TABLE runs ADD COLUMN ${column} ${type}`);
}

export type RunStatus = 'running' | 'success' | 'failed';

export interface RunRecord {
  id: string;
  topic: string;
  model: string | null;
  status: RunStatus;
  errorMessage: string | null;
  location: string | null;
  sourceRunId: string | null;
  sourceStage: string | null;
  background: string | null;
  startedAt: number;
  completedAt: number | null;
  durationMs: number | null;
}

interface RunRow {
  id: string;
  topic: string;
  model: string | null;
  status: RunStatus;
  error_message: string | null;
  location: string | null;
  source_run_id: string | null;
  source_stage: string | null;
  background: string | null;
  started_at: number;
  completed_at: number | null;
  duration_ms: number | null;
}

interface StageRow {
  stage: WorkflowStep;
  payload_json: string;
}

export interface CreateRunInput {
  topic: string;
  model?: string;
  sourceRunId?: string;
  sourceStage?: WorkflowStep;
  background?: string;
}

export function createRun(db: DatabaseType, input: CreateRunInput): string {
  const id = nanoid(12);
  db.prepare(
    `INSERT INTO runs(id, topic, model, status, source_run_id, source_stage, background, started_at)
     VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`,
  ).run(
    id,
    input.topic,
    input.model ?? null,
    input.sourceRunId ?? null,
    input.sourceStage ?? null,
    input.background ?? null,
    Date.now(),
  );
  return id;
}

export function saveStage(
  db: DatabaseType,
  runId: string,
  stage: WorkflowStep,
  payload: unknown,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO run_stages(run_id, stage, payload_json, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(runId, stage, JSON.stringify(payload), Date.now());
}

export interface CompleteRunPatch {
  status: 'success' | 'failed';
  errorMessage?: string;
  location?: string;
}

export function completeRun(db: DatabaseType, id: string, patch: CompleteRunPatch): void {
  const completedAt = Date.now();
  const row = db.prepare(`SELECT started_at FROM runs WHERE id = ?`).get(id) as
    | { started_at: number }
    | undefined;
  const durationMs = row ? completedAt - row.started_at : null;
  db.prepare(
    `UPDATE runs
     SET status = ?, error_message = ?, location = ?, completed_at = ?, duration_ms = ?
     WHERE id = ?`,
  ).run(
    patch.status,
    patch.errorMessage ?? null,
    patch.location ?? null,
    completedAt,
    durationMs,
    id,
  );
}

export interface ListRunsOptions {
  limit?: number;
  status?: RunStatus;
}

export function listRuns(db: DatabaseType, opts: ListRunsOptions = {}): RunRecord[] {
  const limit = opts.limit ?? 50;
  const sql = opts.status
    ? `SELECT * FROM runs WHERE status = ? ORDER BY started_at DESC LIMIT ?`
    : `SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`;
  const rows = (
    opts.status ? db.prepare(sql).all(opts.status, limit) : db.prepare(sql).all(limit)
  ) as RunRow[];
  return rows.map(rowToRun);
}

export interface FullRun {
  run: RunRecord;
  stages: Partial<Record<WorkflowStep, unknown>>;
}

export function getRun(db: DatabaseType, id: string): FullRun | null {
  const row = db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as RunRow | undefined;
  if (!row) return null;
  const stageRows = db
    .prepare(`SELECT stage, payload_json FROM run_stages WHERE run_id = ?`)
    .all(id) as StageRow[];
  const stages: Partial<Record<WorkflowStep, unknown>> = {};
  for (const s of stageRows) {
    if (isWorkflowStep(s.stage)) stages[s.stage] = JSON.parse(s.payload_json);
  }
  return { run: rowToRun(row), stages };
}

function rowToRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    topic: row.topic,
    model: row.model,
    status: row.status,
    errorMessage: row.error_message,
    location: row.location,
    sourceRunId: row.source_run_id,
    sourceStage: row.source_stage,
    background: row.background,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
  };
}

function isWorkflowStep(s: string): s is WorkflowStep {
  return (WORKFLOW_STEPS as readonly string[]).includes(s);
}

export function getImageEmbedding(
  db: DatabaseType,
  url: string,
  modelVersion: string,
): Buffer | null {
  const row = db
    .prepare(`SELECT embedding FROM image_embeddings WHERE url = ? AND model_version = ?`)
    .get(url, modelVersion) as { embedding: Buffer } | undefined;
  return row?.embedding ?? null;
}

export function putImageEmbedding(
  db: DatabaseType,
  url: string,
  modelVersion: string,
  embedding: Buffer,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO image_embeddings(url, model_version, embedding, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(url, modelVersion, embedding, Date.now());
}
