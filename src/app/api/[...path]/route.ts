import { z } from "zod";
import { randomUUID } from "node:crypto";
import { AppError, settingsSchema, unitSchema } from "@/core/domain";
import { authenticate } from "@/server/auth";
import { config } from "@/server/config";
import { Store } from "@/server/store";
import { jobView, saveManual, selectVersion, approve, saveSettings, queueEdit, queueRender, retryOperation, resultLinks, deleteJob } from "@/server/services";
import { startUpload, putPart, completeUpload, cancelUpload, signAsset } from "@/server/storage";
import { webhook } from "@/server/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const revision = z.number().int().nonnegative(), id = z.string().uuid(), key = z.string().min(8).max(128);
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
async function body(request: Request) { const text = await request.text(); if (text.length > 1500000) throw new AppError("TOO_LARGE", "Слишком большой запрос.", 413); try { return JSON.parse(text); } catch { throw new AppError("INVALID_JSON", "Некорректный запрос."); } }
async function handle(request: Request, context: { params: Promise<{ path: string[] }> }) {
  try {
    const { path } = await context.params, store = new Store(), method = request.method;
    if (path[0] === "health" && method === "GET") {
      store.db.prepare("SELECT 1").get();
      const ready = ["BOT_TOKEN", "MEDIA_SIGNING_SECRET", "TELEGRAM_WEBHOOK_SECRET", "OPENAI_API_KEY", "LLM_MODEL", "ASSEMBLYAI_API_KEY", "ALLOWED_TELEGRAM_USER_IDS"].every(n => !!process.env[n]);
      const heartbeat = store.db.prepare("SELECT max(seen_at) AS last FROM worker_heartbeat").get() as { last: number | null };
      const workerReady = heartbeat.last !== null && heartbeat.last > Date.now() - 45000;
      return json({ status: !ready ? "setup_required" : workerReady ? "ok" : "worker_unavailable" }, ready && workerReady ? 200 : 503);
    }
    if (path[0] === "telegram" && method === "POST") return json(await webhook(store, request));
    const owner = authenticate(request);
    if (method !== "GET") store.rateLimit(`${owner}:mutations`, 120, 60);
    if (path.length === 1 && path[0] === "jobs") {
      if (method === "GET") return json({ jobs: store.jobs(owner, Number(new URL(request.url).searchParams.get("before")) || undefined) });
      if (method === "POST") { store.rateLimit(`${owner}:create`, 10, 3600); const input = z.object({ title: z.string().max(240).default("Новый ролик") }).parse(await body(request)); return json(store.createJob(owner, input.title), 201); }
    }
    if (path[0] === "uploads" && path[1]) {
      const uploadId = id.parse(path[1]), lease = request.headers.get("x-upload-lease") || "";
      if (path[2] === "parts" && path[3] && method === "PUT") return json(await putPart(store, owner, uploadId, lease, Number(path[3]), request));
      if (path[2] === "complete" && method === "POST") return json(await completeUpload(store, owner, uploadId, lease), 202);
      if (path.length === 2 && method === "DELETE") { cancelUpload(store, owner, uploadId, lease); return json({ cancelled: true }); }
    }
    if (path[0] === "operations" && path[1]) {
      const opId = id.parse(path[1]), operation = store.operation(opId); store.job(operation.jobId, owner);
      if (method === "GET") return json({ id: opId, state: operation.state, stage: operation.stage, createdAt: operation.createdAt });
      if (path[2] === "cancel" && method === "POST") { store.cancel(opId, owner); return json({ cancelled: true }); }
      if (path[2] === "retry" && method === "POST") { const input = z.object({ idempotencyKey: key }).parse(await body(request)); return json({ operationId: retryOperation(store, owner, opId, input.idempotencyKey).id }, 202); }
    }
    if (path[0] === "jobs" && path[1]) {
      const jobId = id.parse(path[1]); store.job(jobId, owner);
      if (path.length === 2 && method === "GET") return json(jobView(store, jobId, owner));
      if (path.length === 2 && method === "DELETE") { const input = z.object({ revision }).parse(await body(request)); return json(await deleteJob(store, owner, jobId, input.revision)); }
      if (path[2] === "uploads" && method === "POST") { const input = z.object({ revision, fileName: z.string().min(1).max(240), bytes: z.number().int().positive(), mime: z.string().max(160) }).parse(await body(request)); return json(await startUpload(store, owner, jobId, input.revision, input.fileName, input.bytes, input.mime), 201); }
      if (path[2] === "draft" && method === "PATCH") {
        const input = z.object({ revision, baseVersionId: id, text: z.string().max(250000), request: z.string().max(2000), units: z.array(unitSchema).max(15000) }).parse(await body(request));
        return json(store.atomic(() => { const job = store.job(jobId, owner); store.requireRevision(job, input.revision); store.idle(job); if (job.selectedVersionId !== input.baseVersionId) throw new AppError("VERSION_CONFLICT", "Черновик относится к прежней версии.", 409);
          return store.saveJob({ ...job, draft: { baseVersionId: input.baseVersionId, text: input.text, request: input.request, units: input.units }, approvedVersionId: null, phase: "review" }); }));
      }
      if (path[2] === "script" && method === "POST") {
        if (path[3] === "manual") { const input = z.object({ revision, versionId: id, units: z.array(unitSchema).min(1).max(15000) }).parse(await body(request)); return json(saveManual(store, owner, jobId, input.revision, input.versionId, input.units)); }
        if (path[3] === "select") { const input = z.object({ revision, versionId: id }).parse(await body(request)); return json(selectVersion(store, owner, jobId, input.revision, input.versionId)); }
        if (path[3] === "edit") { store.rateLimit(`${owner}:ai`, 20, 3600); const input = z.object({ revision, versionId: id, request: z.string().trim().min(1).max(2000), idempotencyKey: key }).parse(await body(request)); return json({ operationId: queueEdit(store, owner, jobId, input.revision, input.versionId, input.request, input.idempotencyKey).id }, 202); }
      }
      if (path[2] === "approve" && method === "POST") { const input = z.object({ revision, versionId: id, contentHash: z.string().length(64) }).parse(await body(request)); return json(approve(store, owner, jobId, input.revision, input.versionId, input.contentHash)); }
      if (path[2] === "settings" && method === "PATCH") { const input = z.object({ revision, settings: settingsSchema }).parse(await body(request)); return json(saveSettings(store, owner, jobId, input.revision, input.settings)); }
      if (path[2] === "render" && method === "POST") { const input = z.object({ revision, versionId: id, settings: settingsSchema, idempotencyKey: key }).parse(await body(request)); return json({ operationId: queueRender(store, owner, jobId, input.revision, input.versionId, input.settings, input.idempotencyKey).id }, 202); }
      if (path[2] === "media-link" && method === "POST") { const input = z.object({ artifactId: id }).parse(await body(request)); return json(resultLinks(store, owner, jobId, input.artifactId)); }
      if (path[2] === "source-link" && method === "POST") { const job = store.job(jobId, owner); if (!job.sourceAssetId) throw new AppError("NOT_FOUND", "Исходник не найден.", 404); return json({ mediaUrl: `${config().appUrl}/media/${job.sourceAssetId}?${signAsset(job.sourceAssetId, "media")}` }); }
    }
    throw new AppError("NOT_FOUND", "Маршрут не найден.", 404);
  } catch (error) {
    const e = error instanceof AppError ? error : error instanceof z.ZodError ? new AppError("INVALID_INPUT", "Проверьте переданные данные.") : new AppError("INTERNAL_ERROR", "Не удалось выполнить запрос. Работа сохранена.", 500, true);
    return json({ error: { code: e.code, message: e.message, retryable: e.retryable } }, e.status);
  }
}
export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
