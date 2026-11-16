import { readdir, rm, stat } from "node:fs/promises";
import { Store } from "../src/server/store";
import { privatePath } from "../src/server/storage";

const store = new Store(), dayAgo = Date.now() - 86400000;
const uploads = store.db.prepare("SELECT id,job_id FROM uploads WHERE (state='cancelled' AND updated_at<?) OR (state IN ('uploading','completing') AND expires_at<? AND updated_at<?)").all(dayAgo, dayAgo, dayAgo) as { id: string; job_id: string }[];
for (const upload of uploads) {
  store.db.prepare("UPDATE uploads SET state='cancelled' WHERE id=?").run(upload.id);
  await rm(privatePath(`uploads/${upload.id}`), { recursive: true, force: true });
  store.atomic(() => { try { const job = store.job(upload.job_id); if (!job.sourceAssetId && !job.activeOperationId) store.saveJob({ ...job, phase: "cancelled" }); } catch { /* Deleted job. */ } });
}
const done = store.db.prepare("SELECT id FROM operations WHERE state IN ('succeeded','failed','cancelled') AND updated_at<?").all(Date.now() - 3600000) as { id: string }[];
for (const op of done) {
  const dir = privatePath(`work/${op.id}`);
  for (const name of await readdir(dir).catch(() => [])) {
    if (/^(part-\d+\.mkv|asr\.flac|result\.mp4|concat\.txt)$/.test(name)) await rm(`${dir}/${name}`, { force: true });
  }
}
// Only orphaned app-generated outputs; registered originals/results are retained.
for (const name of await readdir(privatePath("output")).catch(() => [])) {
  if (!/^[a-f0-9-]{36}\.mp4$/.test(name)) continue;
  const id = name.slice(0, -4), file = privatePath(`output/${name}`);
  if (store.db.prepare("SELECT 1 FROM assets WHERE id=?").get(id)) continue;
  const active = store.db.prepare("SELECT 1 FROM operations WHERE state IN ('queued','running','waiting_provider') AND json_extract(document,'$.checkpoint.publishingAssetId')=?").get(id);
  if (!active && (await stat(file)).mtimeMs < dayAgo) await rm(file);
}
store.db.prepare("DELETE FROM worker_heartbeat WHERE seen_at<?").run(dayAgo);
store.db.prepare("DELETE FROM rate_limits WHERE expires_at<?").run(Date.now());
store.db.close(); console.log("Temporary storage cleanup completed; registered source/output assets retained.");
