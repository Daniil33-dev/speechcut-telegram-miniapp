import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/store";
import { openDatabase } from "../src/server/db";
import { startUpload, putPart, completeUpload, cancelUpload } from "../src/server/storage";
import { runTool } from "../src/server/media-tools";
import { config } from "../src/server/config";
import { createHash } from "node:crypto";

test("40 MiB multipart transfer, duplicate parts/complete and cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "speechcut-upload-")), prior = process.env.DATA_DIR; process.env.DATA_DIR = root;
  const store = new Store(openDatabase(":memory:"));
  try {
    const path = join(root, "transfer.mp4");
    await runTool(config().ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=black:s=160x240:d=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-c:a", "aac", "-shortest", path]);
    const handle = await open(path, "r+"); const old = (await handle.stat()).size, target = 40 * 1024 * 1024;
    const header = Buffer.alloc(8); header.writeUInt32BE(target - old); header.write("free", 4); await handle.write(header, 0, 8, old); await handle.truncate(target); await handle.close();
    // Padding tests byte transfer, not the compute cost of a long recording.
    const bytes = await readFile(path), job = store.createJob("owner", "transfer-test");
    const upload = await startUpload(store, "owner", job.id, job.revision, "transfer.mp4", bytes.length, "video/mp4");
    await Promise.all(Array.from({ length: Math.ceil(bytes.length / upload.partSize) }, async (_, n) => {
      const part = new Uint8Array(bytes.subarray(n * upload.partSize, (n + 1) * upload.partSize));
      await putPart(store, "owner", upload.id, upload.lease, n, new Request("http://localhost/part", { method: "PUT", body: part }));
      if (!n) await putPart(store, "owner", upload.id, upload.lease, n, new Request("http://localhost/part", { method: "PUT", body: part }));
    }));
    const first = await completeUpload(store, "owner", upload.id, upload.lease), again = await completeUpload(store, "owner", upload.id, upload.lease);
    assert.equal(first.assetId, again.assetId); assert.equal(store.asset(first.assetId!).bytes, target);
    assert.equal(store.asset(first.assetId!).checksum, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM operations WHERE job_id=?").get(job.id)!.n, 1);
    const cancelled = store.createJob("owner", "cancel-test"), other = await startUpload(store, "owner", cancelled.id, 0, "cancel.mov", 10, "");
    cancelUpload(store, "owner", other.id, other.lease);
    await assert.rejects(putPart(store, "owner", other.id, other.lease, 0, new Request("http://localhost/part", { method: "PUT", body: new Uint8Array(10) })));
    await assert.rejects(completeUpload(store, "owner", other.id, other.lease));
    assert.equal(store.job(cancelled.id).phase, "cancelled");
  } finally { store.db.close(); if (prior === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prior; await rm(root, { recursive: true, force: true }); }
});
