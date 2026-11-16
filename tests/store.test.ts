import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../src/server/db";
import { Store } from "../src/server/store";
import { approve, saveManual, queueEdit } from "../src/server/services";
import type { Transcript, UsageEvent } from "../src/core/domain";

function fixture() {
  const store = new Store(openDatabase(":memory:")); let job = store.createJob("owner", "fixture");
  const transcript: Transcript = { id: randomUUID(), jobId: job.id, sourceChecksum: "test", providerRequestId: "test", model: "test", rawText: "да да", words: [0, 1].map(i => ({ id: `w${i}`, rawText: "да", startMs: i * 1000, endMs: i * 1000 + 300, confidence: 1 })), proofreadingStatus: "completed", createdAt: Date.now() };
  store.putTranscript(transcript);
  const version = store.addVersion(job.id, null, transcript.words.map(w => ({ id: w.id, wordIds: [w.id], text: w.rawText })), "test", "ai");
  job = store.saveJob({ ...job, transcriptId: transcript.id, selectedVersionId: version.id, phase: "review" });
  return { store, job, transcript, version };
}
test("ownership and optimistic concurrency are enforced", () => {
  const { store, job } = fixture();
  assert.throws(() => store.job(job.id, "other"));
  store.saveJob({ ...job, title: "changed" });
  assert.throws(() => store.saveJob({ ...job, title: "stale" }));
  assert.equal(store.job(job.id).title, "changed"); store.db.close();
});
test("manual deletion creates a version and revokes approval", () => {
  const { store, job, version } = fixture();
  const approved = approve(store, "owner", job.id, job.revision, version.id, version.contentHash);
  const edited = saveManual(store, "owner", job.id, approved.revision, version.id, version.units.slice(1));
  assert.equal(edited.approvedVersionId, null);
  assert.deepEqual(store.version(edited.selectedVersionId!, job.id).units[0].wordIds, ["w1"]);
  store.db.close();
});
test("operation creation is idempotent and different payload reuse conflicts", () => {
  const { store, job, version } = fixture(), key = "same-key";
  const first = queueEdit(store, "owner", job.id, job.revision, version.id, "Убери повторы", key);
  const second = queueEdit(store, "owner", job.id, job.revision, version.id, "Убери повторы", key);
  assert.equal(first.id, second.id);
  assert.throws(() => queueEdit(store, "owner", job.id, job.revision, version.id, "Другое", key)); store.db.close();
});
test("cancelled operations cannot publish late results or notifications", () => {
  const { store, job, version } = fixture();
  const op = queueEdit(store, "owner", job.id, job.revision, version.id, "Тест", "cancel-test");
  store.claim("worker"); store.cancel(op.id, "owner");
  assert.throws(() => store.finish(op.id, current => ({ ...current, phase: "ready" }), "must not send"));
  assert.equal(store.job(job.id).phase, "cancelled");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM outbox").get()!.n, 0); store.db.close();
});
test("worker recovers request ID and revision-tagged checkpoint after lease expiry", () => {
  const { store, job, version } = fixture();
  const op = queueEdit(store, "owner", job.id, job.revision, version.id, "Тест", "restart-test");
  store.claim("worker-a"); store.checkpoint(op.id, { asrRequestId: "saved", rendererRevision: "old" });
  store.db.prepare("UPDATE operations SET lease_until=0 WHERE id=?").run(op.id);
  const resumed = store.claim("worker-b")!;
  assert.equal(resumed.checkpoint.asrRequestId, "saved"); assert.equal(resumed.attempt, 2); assert.equal(resumed.leaseOwner, "worker-b"); store.db.close();
});
test("usage events update provider results without duplicate billing rows", () => {
  const { store, job, version } = fixture();
  const op = queueEdit(store, "owner", job.id, job.revision, version.id, "Тест", "usage-test");
  const event: UsageEvent = { id: "provider:request", jobId: job.id, operationId: op.id, providerRequestId: "request", provider: "openai", model: "test", kind: "edit", inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, audioSeconds: 0, costUsd: null, costSource: "unknown", pricingVersion: null, createdAt: Date.now() };
  store.recordUsage(event); store.recordUsage({ ...event, costUsd: .01, costSource: "actual" });
  assert.equal(store.usage(job.id).length, 1); assert.equal(store.usage(job.id)[0].costUsd, .01); store.db.close();
});
