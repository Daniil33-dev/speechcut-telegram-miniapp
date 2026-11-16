import test from "node:test";
import assert from "node:assert/strict";
import { uploadParts, UploadPartError, type UploadProgress } from "../src/client/upload";

test("uploader sends three bounded streams, preserves every byte and waits for all acknowledgements", async () => {
  const file = new Blob([new Uint8Array(Array.from({ length: 31 }, (_, i) => i))]);
  const seen = new Map<number, Uint8Array>(), progress: UploadProgress[] = [];
  let active = 0, maximum = 0, acknowledged = 0;
  await uploadParts({ file, partSize: 7, signal: new AbortController().signal, concurrency: 100,
    onProgress: p => { progress.push(p); if (p.percent === 100) assert.equal(acknowledged, 5); },
    send: async (part, blob, signal, report) => {
      active++; maximum = Math.max(maximum, active); assert.equal(signal.aborted, false);
      assert.equal(seen.has(part), false); seen.set(part, new Uint8Array(await blob.arrayBuffer()));
      report(blob.size); await new Promise(resolve => setTimeout(resolve, (5 - part) * 2));
      active--; acknowledged++;
    } });
  assert.equal(maximum, 3); assert.equal(active, 0); assert.equal(seen.size, 5);
  assert.deepEqual([...seen].sort(([a], [b]) => a - b).flatMap(([, b]) => [...b]), [...new Uint8Array(await file.arrayBuffer())]);
  assert.equal(progress.at(-1)?.loaded, 31); assert.equal(progress.at(-1)?.percent, 100);
  assert.ok(progress.every(p => p.loaded <= p.total));
});

test("only a failed retryable part is resent; progress never counts a retry twice", async () => {
  const attempts = new Map<number, number>(), progress: UploadProgress[] = [];
  await uploadParts({ file: new Blob([new Uint8Array(25)]), partSize: 10, signal: new AbortController().signal, retryDelayMs: 0,
    onProgress: p => progress.push(p), send: async (part, blob, _signal, report) => {
      const count = (attempts.get(part) || 0) + 1; attempts.set(part, count); report(blob.size);
      if (part === 1 && count === 1) throw new UploadPartError("network", true);
    } });
  assert.deepEqual([...attempts].sort(([a], [b]) => a - b), [[0, 1], [1, 2], [2, 1]]);
  assert.equal(progress.at(-1)?.loaded, 25); assert.ok(progress.every(p => p.loaded <= 25));
});

test("terminal upload error aborts and drains in-flight parts without scheduling the rest", async () => {
  let active = 0, started = 0;
  await assert.rejects(uploadParts({ file: new Blob([new Uint8Array(100)]), partSize: 10, signal: new AbortController().signal, onProgress: () => {},
    send: async (part, _blob, signal) => {
      started++; active++;
      try {
        if (part === 0) { await new Promise(resolve => setTimeout(resolve, 2)); throw new UploadPartError("forbidden", false); }
        await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      } finally { active--; }
    } }), /forbidden/);
  assert.equal(started, 3); assert.equal(active, 0);
});

test("owner cancellation aborts all streams and never completes the transfer", async () => {
  const controller = new AbortController(); let active = 0, started = 0;
  const pending = uploadParts({ file: new Blob([new Uint8Array(100)]), partSize: 10, signal: controller.signal, onProgress: () => {},
    send: async (_part, _blob, signal) => {
      started++; active++;
      try { await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); }
      finally { active--; }
    } });
  controller.abort(); await assert.rejects(pending, { name: "AbortError" });
  assert.equal(active, 0); assert.equal(started, 3);
});
