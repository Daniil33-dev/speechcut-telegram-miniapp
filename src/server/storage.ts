import { createHash, createHmac, timingSafeEqual, randomUUID, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, statfs, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AppError, type Asset } from "../core/domain";
import { config, requireSecret } from "./config";
import { probe } from "./media-tools";
import { Store } from "./store";

export const PART_BYTES = 8 * 1024 * 1024;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function privatePath(key: string) {
  const root = resolve(config().dataDir), path = resolve(root, key);
  if (!path.startsWith(root + sep)) throw new AppError("INVALID_PATH", "Неверный файл.", 403);
  return path;
}
export async function ensureSpace(bytes: number) {
  await mkdir(config().dataDir, { recursive: true, mode: 0o700 });
  const fs = await statfs(config().dataDir);
  if (Number(fs.bavail) * Number(fs.bsize) < bytes + 256 * 1024 * 1024) throw new AppError("DISK_FULL", "На сервере недостаточно места. Удалите ненужные ролики или освободите место.", 507);
}
type Upload = { id: string; job_id: string; owner_id: string; lease_hash: string; expected_bytes: number; part_size: number; state: string; expires_at: number; file_name: string; mime: string; asset_id: string | null };
export function getUpload(store: Store, id: string, owner: string, lease: string, active = true) {
  const upload = store.db.prepare("SELECT * FROM uploads WHERE id=? AND owner_id=?").get(id, owner) as Upload | undefined;
  if (!upload || !lease || !timingSafeEqual(Buffer.from(upload.lease_hash), Buffer.from(hash(lease)))) throw new AppError("NOT_FOUND", "Загрузка не найдена.", 404);
  store.job(upload.job_id, owner);
  if (active && (upload.expires_at < Date.now() || upload.state !== "uploading")) throw new AppError("UPLOAD_INACTIVE", "Загрузка завершена, отменена или истекла.", 409);
  return upload;
}
export async function startUpload(store: Store, ownerId: string, jobId: string, revision: number, fileName: string, bytes: number, mime: string) {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > config().maxUploadBytes) throw new AppError("UPLOAD_TOO_LARGE", "Предел размера видео — 500 МиБ.", 413);
  if (!/\.(mp4|mov|webm|mkv)$/i.test(fileName)) throw new AppError("MEDIA_TYPE", "Выберите MP4, MOV, WebM или MKV.");
  await ensureSpace(bytes * 3);
  const id = randomUUID(), lease = randomBytes(32).toString("hex"), now = Date.now();
  store.atomic(() => {
    const job = store.job(jobId, ownerId); store.requireRevision(job, revision); store.idle(job);
    if (job.sourceAssetId) throw new AppError("IMMUTABLE_SOURCE", "Для другого исходника создайте новый ролик.", 409);
    const stored = store.db.prepare("SELECT coalesce(sum(json_extract(a.document,'$.bytes')),0) AS bytes FROM assets a JOIN jobs j ON j.id=a.job_id WHERE j.owner_id=? AND j.deleted_at IS NULL").get(ownerId) as { bytes: number };
    const pending = store.db.prepare("SELECT coalesce(sum(expected_bytes),0) AS bytes FROM uploads WHERE owner_id=? AND job_id<>? AND state IN ('uploading','completing') AND expires_at>?").get(ownerId, jobId, Date.now()) as { bytes: number };
    if (Number(stored.bytes) + Number(pending.bytes) + bytes > Number(process.env.MAX_OWNER_STORAGE_BYTES || 10737418240)) throw new AppError("STORAGE_QUOTA", "Достигнут предел хранения 10 ГиБ. Удалите ненужные ролики.", 413);
    store.db.prepare("UPDATE uploads SET state='cancelled' WHERE job_id=? AND state='uploading'").run(job.id);
    store.db.prepare("INSERT INTO uploads(id,job_id,owner_id,lease_hash,expected_bytes,part_size,state,expires_at,updated_at,file_name,mime) VALUES(?,?,?,?,?,?,'uploading',?,?,?,?)")
      .run(id, jobId, ownerId, hash(lease), bytes, PART_BYTES, now + 6 * 3600000, now, fileName.slice(0, 240), mime);
    store.saveJob({ ...job, phase: "uploading", title: fileName.slice(0, 240) });
  });
  await mkdir(privatePath(`uploads/${id}`), { recursive: true, mode: 0o700 });
  return { id, lease, partSize: PART_BYTES, expectedBytes: bytes };
}
export async function putPart(store: Store, ownerId: string, id: string, lease: string, partNo: number, request: Request) {
  const upload = getUpload(store, id, ownerId, lease);
  const count = Math.ceil(upload.expected_bytes / upload.part_size);
  if (!Number.isInteger(partNo) || partNo < 0 || partNo >= count || !request.body) throw new AppError("INVALID_PART", "Некорректная часть файла.");
  const expectedBytes = partNo === count - 1 ? upload.expected_bytes - partNo * upload.part_size : upload.part_size;
  const temp = privatePath(`uploads/${id}/${partNo}-${randomUUID()}.tmp`), target = privatePath(`uploads/${id}/${partNo}.part`);
  let size = 0; const checksum = createHash("sha256");
  const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) { size += chunk.length; if (size > expectedBytes) callback(new AppError("PART_TOO_LARGE", "Часть файла превышает допустимый размер.", 413)); else { checksum.update(chunk); callback(null, chunk); } } });
  try {
    await pipeline(Readable.fromWeb(request.body as never), limiter, createWriteStream(temp, { flags: "wx", mode: 0o600 }), { signal: request.signal });
    if (size !== expectedBytes) throw new AppError("PART_INCOMPLETE", "Часть файла передана не полностью.");
    const digest = checksum.digest("hex");
    let duplicate = false;
    store.atomic(() => {
      getUpload(store, id, ownerId, lease);
      const existing = store.db.prepare("SELECT checksum FROM upload_parts WHERE upload_id=? AND part_no=?").get(id, partNo) as { checksum: string } | undefined;
      if (existing) { if (existing.checksum !== digest) throw new AppError("PART_CONFLICT", "Эта часть файла уже передана с другим содержимым.", 409); duplicate = true; }
      else store.db.prepare("INSERT INTO upload_parts VALUES(?,?,?,?)").run(id, partNo, size, digest);
    });
    // The write completes before its index becomes visible to completion. A crash
    // before rename is detected by complete and repaired by re-uploading the part.
    if (!duplicate) await rename(temp, target);
    else if (!(await stat(target).catch(() => null))) await rename(temp, target);
    store.db.prepare("UPDATE uploads SET updated_at=? WHERE id=?").run(Date.now(), id);
    return { partNo, bytes: size };
  } finally { await rm(temp, { force: true }); }
}
export async function completeUpload(store: Store, ownerId: string, id: string, lease: string) {
  const initial = getUpload(store, id, ownerId, lease, false);
  if (initial.state === "completed") return { jobId: initial.job_id, assetId: initial.asset_id };
  store.db.prepare("UPDATE uploads SET state='uploading' WHERE id=? AND state='completing' AND updated_at<?").run(id, Date.now() - 300000);
  const upload = store.atomic(() => { const u = getUpload(store, id, ownerId, lease); store.db.prepare("UPDATE uploads SET state='completing',updated_at=? WHERE id=?").run(Date.now(), id); return u; });
  const tmpKey = `source/${randomUUID()}.tmp`, tmp = privatePath(tmpKey);
  try {
    const parts = store.db.prepare("SELECT part_no,bytes,checksum FROM upload_parts WHERE upload_id=? ORDER BY part_no").all(id) as { part_no: number; bytes: number; checksum: string }[];
    if (parts.length !== Math.ceil(upload.expected_bytes / upload.part_size) || parts.reduce((n, p) => n + p.bytes, 0) !== upload.expected_bytes) throw new AppError("UPLOAD_INCOMPLETE", "Не все части видео загружены.", 409);
    await ensureSpace(upload.expected_bytes * 2);
    await mkdir(privatePath("source"), { recursive: true, mode: 0o700 });
    const whole = createHash("sha256");
    async function* chunks() {
      for (const part of parts) {
        let bytes = 0; const digest = createHash("sha256");
        for await (const chunk of createReadStream(privatePath(`uploads/${id}/${part.part_no}.part`))) { const b = chunk as Buffer; bytes += b.length; digest.update(b); whole.update(b); yield b; }
        if (bytes !== part.bytes || digest.digest("hex") !== part.checksum) throw new AppError("PART_CORRUPT", "Файл передан с ошибкой. Повторите загрузку.");
      }
    }
    await pipeline(Readable.from(chunks()), createWriteStream(tmp, { flags: "wx", mode: 0o600 }));
    const media = await probe(tmp);
    const assetId = randomUUID(), storageKey = `source/${assetId}.media`;
    await rename(tmp, privatePath(storageKey));
    try {
      store.atomic(() => {
        const current = getUpload(store, id, ownerId, lease, false), job = store.job(upload.job_id, ownerId);
        if (current.state !== "completing" || job.phase === "cancelled" || job.sourceAssetId) throw new AppError("UPLOAD_INACTIVE", "Загрузка уже отменена или завершена.", 409);
        const mime = /\.mov$/i.test(upload.file_name) ? "video/quicktime" : /\.webm$/i.test(upload.file_name) ? "video/webm" : /\.mkv$/i.test(upload.file_name) ? "video/x-matroska" : "video/mp4";
        const asset: Asset = { id: assetId, jobId: job.id, kind: "source", storageKey, mime, bytes: upload.expected_bytes, checksum: whole.digest("hex"), media, createdAt: Date.now() };
        store.addAsset(asset);
        const attached = store.saveJob({ ...job, sourceAssetId: assetId });
        store.db.prepare("UPDATE uploads SET state='completed',asset_id=? WHERE id=?").run(assetId, id);
        store.enqueue(attached, "transcribe", {}, `upload-${id}`);
      });
    } catch (error) { await rm(privatePath(storageKey), { force: true }); throw error; }
    await rm(privatePath(`uploads/${id}`), { recursive: true, force: true });
    return { jobId: upload.job_id, assetId };
  } catch (error) { store.db.prepare("UPDATE uploads SET state='uploading' WHERE id=? AND state='completing'").run(id); throw error; }
  finally { await rm(tmp, { force: true }); }
}
export function cancelUpload(store: Store, ownerId: string, id: string, lease: string) {
  store.atomic(() => { const upload = getUpload(store, id, ownerId, lease, false); if (upload.state === "completed") throw new AppError("UPLOAD_COMPLETED", "Загрузка уже завершена. Остановите обработку ролика.", 409);
    store.db.prepare("UPDATE uploads SET state='cancelled',updated_at=? WHERE id=?").run(Date.now(), id);
    const job = store.job(upload.job_id, ownerId); if (!job.activeOperationId) store.saveJob({ ...job, phase: "cancelled" });
  });
}

export function signAsset(assetId: string, purpose: "media" | "save" | "download", ttlSeconds = 3600) {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = createHmac("sha256", requireSecret("MEDIA_SIGNING_SECRET")).update(`${purpose}:${assetId}:${expires}`).digest("hex");
  return `expires=${expires}&sig=${sig}`;
}
export function verifyAssetSignature(id: string, purpose: "media" | "save" | "download", params: URLSearchParams) {
  const expires = Number(params.get("expires")), sig = params.get("sig") || "";
  if (!Number.isSafeInteger(expires) || expires < Date.now() / 1000 || expires > Date.now() / 1000 + 86400 || !/^[a-f0-9]{64}$/i.test(sig)) throw new AppError("LINK_EXPIRED", "Ссылка истекла. Откройте ролик через приложение и обновите её.", 403);
  const expected = createHmac("sha256", requireSecret("MEDIA_SIGNING_SECRET")).update(`${purpose}:${id}:${expires}`).digest();
  if (!timingSafeEqual(expected, Buffer.from(sig, "hex"))) throw new AppError("FORBIDDEN", "Неверная ссылка.", 403);
}

export async function streamAsset(asset: Asset, request: Request, attachment = false) {
  const path = privatePath(asset.storageKey), file = await stat(path);
  const range = request.headers.get("range"); let start = 0, end = file.size - 1, status = 200;
  const headers = new Headers({ "Content-Type": asset.mime, "Accept-Ranges": "bytes", "Cache-Control": "private, no-store", "Content-Disposition": `inline; filename="video-${asset.id}.mp4"` });
  if (attachment) { headers.set("Content-Disposition", 'attachment; filename="video.mp4"'); headers.set("Access-Control-Allow-Origin", "https://web.telegram.org"); }
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${file.size}` } });
    if (!match[1]) start = Math.max(0, file.size - Number(match[2]));
    else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= file.size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${file.size}` } });
    status = 206; headers.set("Content-Range", `bytes ${start}-${end}/${file.size}`);
  }
  headers.set("Content-Length", String(end - start + 1));
  if (request.method === "HEAD") return new Response(null, { status, headers });
  const body = createReadStream(path, { start, end });
  request.signal.addEventListener("abort", () => body.destroy(), { once: true });
  return new Response(Readable.toWeb(body) as ReadableStream, { status, headers });
}
