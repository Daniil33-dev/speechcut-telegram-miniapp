import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { AppError, type ScriptUnit, type Settings } from "../core/domain";
import { validateManualEdit, contentHash } from "../core/script-document";
import { summarizeUsage } from "../core/usage";
import { Store } from "./store";
import { privatePath, signAsset } from "./storage";
import { config } from "./config";

export function jobView(store: Store, id: string, owner: string) {
  const job = store.job(id, owner);
  const usage = store.usage(id), artifacts = store.artifacts(id);
  const source = job.sourceAssetId ? store.asset(job.sourceAssetId, id) : null;
  const op = job.activeOperationId ? store.operation(job.activeOperationId) : null;
  const lastRow = store.db.prepare("SELECT id FROM operations WHERE job_id=? ORDER BY created_at DESC LIMIT 1").get(id) as { id: string } | undefined;
  const last = lastRow ? store.operation(lastRow.id) : null;
  return { job, transcript: job.transcriptId ? store.transcript(job.transcriptId, id) : null,
    versions: store.versions(id), artifacts: artifacts.map(a => ({ id: a.id, scriptVersionId: a.scriptVersionId, settings: a.settings, createdAt: a.createdAt,
      qaSummary: a.qaSummary, bytes: store.asset(a.outputAssetId, id).bytes })),
    source: source ? { duration: source.media.duration, width: source.media.width, height: source.media.height, rotation: source.media.rotation } : null,
    operation: op ? { id: op.id, type: op.type, state: op.state, stage: op.stage, createdAt: op.createdAt } : null,
    lastOperation: last ? { id: last.id, state: last.state, type: last.type } : null,
    usage, expense: summarizeUsage(usage), retention: "Исходники и результаты хранятся до ручного удаления. Инфраструктура не входит в API-оценку." };
}
export function saveManual(store: Store, owner: string, id: string, revision: number, baseVersionId: string, units: ScriptUnit[]) {
  return store.atomic(() => {
    const job = store.job(id, owner); store.requireRevision(job, revision); store.idle(job);
    if (job.selectedVersionId !== baseVersionId) throw new AppError("VERSION_CONFLICT", "Выбрана другая версия. Сохраните черновик и обновите сценарий.", 409);
    const parent = store.version(baseVersionId, id), transcript = store.transcript(job.transcriptId!, id);
    validateManualEdit(units, parent.units, transcript.words);
    if (contentHash(units) === parent.contentHash) return store.saveJob({ ...job, draft: null });
    const version = store.addVersion(id, parent.id, units, "Ручная правка", "user");
    return store.saveJob({ ...job, selectedVersionId: version.id, approvedVersionId: null, draft: null, phase: "review" });
  });
}
export function selectVersion(store: Store, owner: string, id: string, revision: number, versionId: string) {
  return store.atomic(() => { const job = store.job(id, owner); store.requireRevision(job, revision); store.idle(job); store.version(versionId, id);
    return store.saveJob({ ...job, selectedVersionId: versionId, approvedVersionId: null, draft: null, phase: "review" }); });
}
export function approve(store: Store, owner: string, id: string, revision: number, versionId: string, hash: string) {
  return store.atomic(() => {
    const job = store.job(id, owner); store.requireRevision(job, revision); store.idle(job);
    const version = store.version(versionId, id), transcript = store.transcript(job.transcriptId!, id);
    if (job.selectedVersionId !== versionId || version.contentHash !== hash || !version.units.length || transcript.proofreadingStatus !== "completed" || job.draft)
      throw new AppError("APPROVAL_REQUIRED", "Сначала сохраните актуальный сценарий и примените или отмените ввод.", 409);
    return store.saveJob({ ...job, approvedVersionId: versionId, phase: "approved" });
  });
}
export function saveSettings(store: Store, owner: string, id: string, revision: number, settings: Settings) {
  return store.atomic(() => { const job = store.job(id, owner); store.requireRevision(job, revision); store.idle(job); return store.saveJob({ ...job, settings }); });
}
export function queueEdit(store: Store, owner: string, id: string, revision: number, versionId: string, request: string, key: string) {
  const payload = { versionId, request };
  return store.atomic(() => {
    const job = store.job(id, owner), existing = store.findOperation(`${id}:edit:${key}`, payload); if (existing) return existing;
    store.requireRevision(job, revision);
    if (job.selectedVersionId !== versionId || job.draft) throw new AppError("UNSAVED_DRAFT", "Сначала сохраните ручную правку.", 409);
    const transcript = store.transcript(job.transcriptId!, id);
    if (transcript.proofreadingStatus !== "completed") throw new AppError("PROOFREAD_REQUIRED", "Дождитесь проверки текста.", 409);
    return store.enqueue(job, "edit", payload, key);
  });
}
export function queueRender(store: Store, owner: string, id: string, revision: number, versionId: string, settings: Settings, key: string) {
  const payload = { versionId, settings };
  return store.atomic(() => {
    const job = store.job(id, owner), existing = store.findOperation(`${id}:render:${key}`, payload); if (existing) return existing;
    store.requireRevision(job, revision);
    if (job.approvedVersionId !== versionId || job.selectedVersionId !== versionId || job.draft || JSON.stringify(job.settings) !== JSON.stringify(settings))
      throw new AppError("APPROVAL_REQUIRED", "Подтвердите актуальную версию и сохраните настройки.", 409);
    if (store.transcript(job.transcriptId!, id).proofreadingStatus !== "completed") throw new AppError("PROOFREAD_REQUIRED", "Текст ещё не прошёл проверку.", 409);
    return store.enqueue(job, "render", payload, key);
  });
}
export function retryOperation(store: Store, owner: string, id: string, key: string) {
  return store.atomic(() => {
    const previous = store.operation(id), job = store.job(previous.jobId, owner);
    const payload = previous.payload, existing = store.findOperation(`${job.id}:${previous.type}:${key}`, payload); if (existing) return existing;
    if (!["failed", "cancelled"].includes(previous.state)) throw new AppError("NOT_RETRYABLE", "Эта операция уже выполняется или завершена.", 409);
    if (["edit", "render"].includes(previous.type) && job.selectedVersionId !== previous.inputVersionId) throw new AppError("VERSION_CONFLICT", "Сценарий изменился. Создайте новую операцию.", 409);
    if (previous.type === "render" && job.approvedVersionId !== previous.inputVersionId) throw new AppError("APPROVAL_REQUIRED", "Повторно подтвердите сценарий.", 409);
    const operation = store.enqueue(job, previous.type, payload, key);
    store.saveOperation({ ...operation, checkpoint: previous.checkpoint });
    return operation;
  });
}
export function resultLinks(store: Store, owner: string, jobId: string, artifactId: string) {
  store.job(jobId, owner); const artifact = store.artifact(artifactId);
  if (artifact.jobId !== jobId) throw new AppError("NOT_FOUND", "Результат не найден.", 404);
  const asset = store.asset(artifact.outputAssetId, jobId), base = config().appUrl;
  return { mediaUrl: `${base}/media/${asset.id}?${signAsset(asset.id, "media")}`, downloadUrl: `${base}/media/${asset.id}?download=1&${signAsset(asset.id, "download")}`, saveUrl: `${base}/save/${artifact.id}?${signAsset(artifact.id, "save")}`, bytes: asset.bytes, expiresIn: 3600 };
}
export async function deleteJob(store: Store, owner: string, id: string, revision: number) {
  const files = store.assets(id).map(a => a.storageKey), operations = store.db.prepare("SELECT id FROM operations WHERE job_id=?").all(id) as { id: string }[];
  const tickets = operations.map(o => store.operation(o.id).checkpoint.asrRequestId).filter(Boolean);
  store.atomic(() => {
    const job = store.job(id, owner); store.requireRevision(job, revision);
    for (const { id: opId } of operations) { const op = store.operation(opId); store.saveOperation({ ...op, state: "cancelled", cancelRequestedAt: Date.now(), checkpoint: {}, payload: {}, leaseUntil: null }); }
    store.db.prepare("UPDATE uploads SET state='cancelled' WHERE job_id=?").run(id);
    store.db.prepare("UPDATE outbox SET state='cancelled' WHERE job_id=?").run(id);
    store.db.prepare("DELETE FROM artifacts WHERE job_id=?").run(id);
    store.db.prepare("UPDATE uploads SET asset_id=NULL WHERE job_id=?").run(id);
    store.db.prepare("DELETE FROM assets WHERE job_id=?").run(id);
    store.db.prepare("DELETE FROM versions WHERE job_id=?").run(id);
    store.db.prepare("DELETE FROM transcripts WHERE job_id=?").run(id);
    store.saveJob({ ...job, title: "Удалённый ролик", deletedAt: Date.now(), sourceAssetId: null, transcriptId: null, selectedVersionId: null, approvedVersionId: null, draft: null, activeOperationId: null, phase: "cancelled", lastError: null });
  });
  for (const key of files) await rm(privatePath(key), { force: true });
  for (const op of operations) await rm(privatePath(`work/${op.id}`), { recursive: true, force: true });
  const uploads = store.db.prepare("SELECT id FROM uploads WHERE job_id=?").all(id) as { id: string }[];
  for (const upload of uploads) await rm(privatePath(`uploads/${upload.id}`), { recursive: true, force: true });
  let providerDeleted = true;
  for (const ticket of new Set(tickets)) {
    try { const response = await fetch(`https://api.assemblyai.com/v2/transcript/${encodeURIComponent(String(ticket))}`, { method: "DELETE", headers: { authorization: process.env.ASSEMBLYAI_API_KEY || "" }, signal: AbortSignal.timeout(10000) }); if (!response.ok && response.status !== 404) providerDeleted = false; }
    catch { providerDeleted = false; }
  }
  return { deleted: true, providerDeleted, backupNotice: "Текст может оставаться в резервных копиях БД до окончания их срока хранения." };
}
