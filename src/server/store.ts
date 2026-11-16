import { randomUUID, createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AppError, defaultSettings, type Job, type Operation, type OperationType, type ScriptVersion, type Transcript, type Asset, type Artifact, type UsageEvent } from "../core/domain";
import { contentHash } from "../core/script-document";
import { database, transaction } from "./db";

type Row = Record<string, unknown>;
const decode = <T>(row: unknown): T | null => row ? JSON.parse((row as Row).document as string) : null;
export class Store {
  constructor(public db: DatabaseSync = database()) {}
  atomic<T>(fn: () => T) { return transaction(this.db, fn); }
  job(id: string, ownerId?: string): Job {
    const job = decode<Job>(this.db.prepare("SELECT document FROM jobs WHERE id=? AND deleted_at IS NULL").get(id));
    if (!job || (ownerId && job.ownerId !== ownerId)) throw new AppError("NOT_FOUND", "Ролик не найден.", 404);
    return job;
  }
  jobs(ownerId: string, before = Number.MAX_SAFE_INTEGER) {
    return this.db.prepare("SELECT document FROM jobs WHERE owner_id=? AND deleted_at IS NULL AND created_at<? ORDER BY created_at DESC LIMIT 30").all(ownerId, before).map(r => decode<Job>(r)!);
  }
  createJob(ownerId: string, title: string) {
    const now = Date.now();
    const job: Job = { id: randomUUID(), ownerId, title, phase: "draft", revision: 0, sourceAssetId: null, transcriptId: null,
      selectedVersionId: null, approvedVersionId: null, activeOperationId: null, settings: { ...defaultSettings }, draft: null, lastError: null,
      createdAt: now, updatedAt: now, deletedAt: null };
    this.db.prepare("INSERT INTO jobs VALUES(?,?,?,?,?,?,?,NULL)").run(job.id, ownerId, 0, job.phase, JSON.stringify(job), now, now);
    return job;
  }
  saveJob(job: Job, expectedRevision = job.revision) {
    const next = { ...job, revision: expectedRevision + 1, updatedAt: Date.now() };
    const changed = this.db.prepare("UPDATE jobs SET revision=?,phase=?,document=?,updated_at=?,deleted_at=? WHERE id=? AND revision=?").run(next.revision, next.phase, JSON.stringify(next), next.updatedAt, next.deletedAt, next.id, expectedRevision);
    if (!changed.changes) throw new AppError("REVISION_CONFLICT", "Ролик изменился в другом окне. Обновите его перед сохранением.", 409);
    return next;
  }
  requireRevision(job: Job, revision: number) { if (job.revision !== revision) throw new AppError("REVISION_CONFLICT", "Ролик изменился. Обновите страницу.", 409); }
  idle(job: Job) { if (job.activeOperationId) throw new AppError("OPERATION_ACTIVE", "Дождитесь завершения обработки или отмените её.", 409); }
  version(id: string, jobId: string) { const value = decode<ScriptVersion>(this.db.prepare("SELECT document FROM versions WHERE id=? AND job_id=?").get(id, jobId)); if (!value) throw new AppError("VERSION_NOT_FOUND", "Версия не найдена.", 404); return value; }
  versions(jobId: string) { return this.db.prepare("SELECT document FROM versions WHERE job_id=? ORDER BY rowid").all(jobId).map(r => decode<ScriptVersion>(r)!); }
  addVersion(jobId: string, parentId: string | null, units: ScriptVersion["units"], request: string, author: ScriptVersion["author"]) {
    const version: ScriptVersion = { id: randomUUID(), jobId, parentId, units, request, author, contentHash: contentHash(units), createdAt: Date.now() };
    this.db.prepare("INSERT INTO versions VALUES(?,?,?,?)").run(version.id, jobId, parentId, JSON.stringify(version)); return version;
  }
  transcript(id: string, jobId: string) { const value = decode<Transcript>(this.db.prepare("SELECT document FROM transcripts WHERE id=? AND job_id=?").get(id, jobId)); if (!value) throw new AppError("TRANSCRIPT_NOT_FOUND", "Расшифровка ещё не готова.", 409); return value; }
  putTranscript(value: Transcript) { this.db.prepare("INSERT INTO transcripts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document").run(value.id, value.jobId, JSON.stringify(value)); }
  asset(id: string, jobId?: string) { const value = decode<Asset>(this.db.prepare("SELECT document FROM assets WHERE id=?").get(id)); if (!value || (jobId && value.jobId !== jobId)) throw new AppError("ASSET_NOT_FOUND", "Файл не найден.", 404); return value; }
  assets(jobId: string) { return this.db.prepare("SELECT document FROM assets WHERE job_id=?").all(jobId).map(r => decode<Asset>(r)!); }
  addAsset(asset: Asset) { this.db.prepare("INSERT INTO assets VALUES(?,?,?)").run(asset.id, asset.jobId, JSON.stringify(asset)); }
  artifacts(jobId: string) { return this.db.prepare("SELECT document FROM artifacts WHERE job_id=? ORDER BY rowid DESC").all(jobId).map(r => decode<Artifact>(r)!); }
  artifact(id: string) { const artifact = decode<Artifact>(this.db.prepare("SELECT document FROM artifacts WHERE id=?").get(id)); if (!artifact) throw new AppError("NOT_FOUND", "Результат не найден.", 404); this.job(artifact.jobId); return artifact; }
  addArtifact(artifact: Artifact) { this.db.prepare("INSERT INTO artifacts VALUES(?,?,?,?,?)").run(artifact.id, artifact.jobId, artifact.scriptVersionId, artifact.outputAssetId, JSON.stringify(artifact)); }
  operation(id: string): Operation {
    const row = this.db.prepare("SELECT * FROM operations WHERE id=?").get(id) as Row | undefined;
    if (!row) throw new AppError("NOT_FOUND", "Операция не найдена.", 404);
    return { ...JSON.parse(row.document as string), state: row.state, attempt: row.attempt, leaseOwner: row.lease_owner, leaseUntil: row.lease_until, cancelRequestedAt: row.cancel_requested_at };
  }
  findOperation(idempotencyKey: string, payload: unknown) {
    const row = this.db.prepare("SELECT id,payload_hash FROM operations WHERE idempotency_key=?").get(idempotencyKey) as Row | undefined;
    if (!row) return null;
    const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    if (row.payload_hash !== hash) throw new AppError("IDEMPOTENCY_CONFLICT", "Этот запрос уже использован с другими параметрами.", 409);
    return this.operation(row.id as string);
  }
  enqueue(job: Job, type: OperationType, payload: Record<string, unknown>, idempotencyKey: string) {
    const scopedKey = `${job.id}:${type}:${idempotencyKey}`;
    const existing = this.findOperation(scopedKey, payload); if (existing) return existing;
    this.idle(job);
    const now = Date.now();
    const operation: Operation = { id: randomUUID(), jobId: job.id, type, state: "queued", inputRevision: job.revision,
      inputVersionId: job.selectedVersionId, payload, checkpoint: {}, attempt: 0, leaseOwner: null, leaseUntil: null, cancelRequestedAt: null,
      stage: "В очереди", createdAt: now, updatedAt: now };
    this.db.prepare("INSERT INTO operations(id,job_id,type,state,idempotency_key,payload_hash,created_at,updated_at,document) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(operation.id, job.id, type, operation.state, scopedKey, createHash("sha256").update(JSON.stringify(payload)).digest("hex"), now, now, JSON.stringify(operation));
    this.saveJob({ ...job, activeOperationId: operation.id, lastError: null,
      phase: type === "render" ? "rendering" : type === "transcribe" ? "transcribing" : type === "proofread" ? "proofreading" : job.phase });
    return operation;
  }
  saveOperation(operation: Operation) {
    operation = { ...operation, updatedAt: Date.now() };
    this.db.prepare("UPDATE operations SET state=?,attempt=?,lease_owner=?,lease_until=?,cancel_requested_at=?,updated_at=?,document=? WHERE id=?")
      .run(operation.state, operation.attempt, operation.leaseOwner, operation.leaseUntil, operation.cancelRequestedAt, operation.updatedAt, JSON.stringify(operation), operation.id);
  }
  claim(workerId: string) {
    return this.atomic(() => {
      const now = Date.now();
      const row = this.db.prepare("SELECT id FROM operations WHERE cancel_requested_at IS NULL AND (state='queued' OR (state IN ('running','waiting_provider') AND lease_until<?)) ORDER BY created_at LIMIT 1").get(now) as Row | undefined;
      if (!row) return null;
      const op = this.operation(row.id as string);
      const job = this.job(op.jobId);
      if (op.attempt >= 3 || job.activeOperationId !== op.id) {
        this.saveOperation({ ...op, state: "failed", leaseUntil: null });
        if (job.activeOperationId === op.id) this.saveJob({ ...job, phase: "recoverable_error", activeOperationId: null, lastError: { code: "RETRY_LIMIT", message: "Обработка прерывалась несколько раз. Можно повторить её вручную.", retryable: true } });
        return null;
      }
      const next: Operation = { ...op, state: "running", attempt: op.attempt + 1, leaseOwner: workerId, leaseUntil: now + 45000 };
      this.saveOperation(next); return next;
    });
  }
  heartbeat(id: string, workerId: string) {
    const now = Date.now();
    this.db.prepare("INSERT INTO worker_heartbeat VALUES(?,?) ON CONFLICT(id) DO UPDATE SET seen_at=excluded.seen_at").run(workerId, now);
    return this.db.prepare("UPDATE operations SET lease_until=? WHERE id=? AND lease_owner=? AND state IN ('running','waiting_provider') AND cancel_requested_at IS NULL").run(now + 45000, id, workerId).changes > 0;
  }
  checkpoint(id: string, patch: Record<string, unknown>, stage?: string) {
    this.atomic(() => { const op = this.operation(id); if (op.state !== "running" || op.cancelRequestedAt) throw new AppError("CANCELLED", "Обработка отменена.", 409); this.saveOperation({ ...op, checkpoint: { ...op.checkpoint, ...patch }, stage: stage || op.stage }); });
  }
  assertActive(id: string) {
    const op = this.operation(id), job = this.job(op.jobId);
    if (op.cancelRequestedAt || op.state !== "running" || job.activeOperationId !== op.id) throw new AppError("CANCELLED", "Обработка отменена.", 409);
    return { op, job };
  }
  finish(id: string, apply: (job: Job, op: Operation) => Job, notification?: string) {
    return this.atomic(() => {
      const { job, op } = this.assertActive(id);
      const next = this.saveJob({ ...apply(job, op), activeOperationId: null, lastError: null });
      this.saveOperation({ ...op, state: "succeeded", leaseUntil: null, stage: "Готово" });
      if (notification) this.db.prepare("INSERT OR IGNORE INTO outbox(id,event_key,job_id,operation_id,payload) VALUES(?,?,?,?,?)")
        .run(randomUUID(), `${op.id}:success`, job.id, op.id, JSON.stringify({ ownerId: job.ownerId, text: notification }));
      return next;
    });
  }
  cancel(id: string, ownerId: string) {
    return this.atomic(() => {
      const op = this.operation(id), job = this.job(op.jobId, ownerId);
      if (["succeeded", "failed", "cancelled"].includes(op.state)) return op;
      const next: Operation = { ...op, state: "cancelled", cancelRequestedAt: Date.now(), leaseUntil: null, stage: "Отменено" };
      this.saveOperation(next);
      if (job.activeOperationId === id) this.saveJob({ ...job, activeOperationId: null, phase: "cancelled" });
      return next;
    });
  }
  fail(id: string, error: { code: string; message: string; retryable: boolean }) {
    this.atomic(() => { const op = this.operation(id), job = this.job(op.jobId); if (op.state === "cancelled" || job.activeOperationId !== id) return;
      this.saveOperation({ ...op, state: "failed", leaseUntil: null, stage: error.message });
      this.saveJob({ ...job, activeOperationId: null, phase: "recoverable_error", lastError: error });
    });
  }
  recordUsage(event: UsageEvent) { this.db.prepare("INSERT INTO usage_events VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document WHERE usage_events.provider_request_id=excluded.provider_request_id").run(event.id, event.jobId, event.operationId, event.providerRequestId, JSON.stringify(event)); }
  usage(jobId: string) { return this.db.prepare("SELECT document FROM usage_events WHERE job_id=? ORDER BY rowid").all(jobId).map(r => decode<UsageEvent>(r)!); }
  rateLimit(bucket: string, maximum: number, seconds: number) {
    this.atomic(() => { const now = Date.now(); this.db.prepare("INSERT INTO rate_limits VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN expires_at<? THEN 1 ELSE count+1 END, expires_at=CASE WHEN expires_at<? THEN excluded.expires_at ELSE expires_at END").run(bucket, now + seconds * 1000, now, now);
      const row = this.db.prepare("SELECT count FROM rate_limits WHERE bucket=?").get(bucket) as Row;
      if (Number(row.count) > maximum) throw new AppError("RATE_LIMIT", "Слишком много запросов. Попробуйте немного позже.", 429, true);
    });
  }
}
