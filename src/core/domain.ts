import { z } from "zod";

export const settingsSchema = z.object({
  subtitles: z.boolean().default(true),
  subtitlePosition: z.number().min(15).max(85).default(77),
  removePauses: z.boolean().default(true)
});
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings: Settings = settingsSchema.parse({});
export type Phase = "draft" | "uploading" | "transcribing" | "proofreading" | "review" | "approved" | "rendering" | "ready" | "cancelled" | "recoverable_error";
export type OperationType = "transcribe" | "proofread" | "edit" | "render" | "delete";
export type OperationState = "queued" | "running" | "waiting_provider" | "succeeded" | "failed" | "cancelled";
export type Word = { id: string; rawText: string; startMs: number; endMs: number; confidence: number };
export type ScriptUnit = { id: string; wordIds: string[]; text: string };
export type ScriptVersion = { id: string; jobId: string; parentId: string | null; units: ScriptUnit[]; request: string; author: "user" | "ai"; contentHash: string; createdAt: number };
export type Transcript = { id: string; jobId: string; sourceChecksum: string; providerRequestId: string; model: string; rawText: string; words: Word[]; proofreadingStatus: "pending" | "completed"; createdAt: number };
export type Job = { id: string; ownerId: string; title: string; phase: Phase; revision: number; sourceAssetId: string | null; transcriptId: string | null; selectedVersionId: string | null; approvedVersionId: string | null; activeOperationId: string | null; settings: Settings; draft: { baseVersionId: string; text: string; request?: string; units?: ScriptUnit[] } | null; lastError: { code: string; message: string; retryable: boolean } | null; createdAt: number; updatedAt: number; deletedAt: number | null };
export type Operation = { id: string; jobId: string; type: OperationType; state: OperationState; inputRevision: number; inputVersionId: string | null; payload: Record<string, unknown>; checkpoint: Record<string, unknown>; attempt: number; leaseOwner: string | null; leaseUntil: number | null; cancelRequestedAt: number | null; stage: string; createdAt: number; updatedAt: number };
export type MediaInfo = { duration: number; width: number; height: number; rotation: number; sar: string; videoCodec: string; audioCodec: string; hdr: boolean };
export type Asset = { id: string; jobId: string; kind: "source" | "output" | "thumbnail"; storageKey: string; mime: string; bytes: number; checksum: string; media: MediaInfo; createdAt: number };
export type Artifact = { id: string; jobId: string; scriptVersionId: string; settings: Settings; rendererRevision: string; outputAssetId: string; editMapPath: string; qaSummary: Record<string, unknown>; createdAt: number };
export type UsageEvent = { id: string; jobId: string; operationId: string; providerRequestId: string; provider: "openai" | "assemblyai"; model: string; kind: string; inputTokens: number; cachedInputTokens: number; cacheWriteTokens?: number; cacheWrite12hTokens?: number; outputTokens: number; audioSeconds: number; costUsd: number | null; pricingVersion: string | null; costSource: "actual" | "estimate" | "unknown"; createdAt: number };

export class AppError extends Error {
  constructor(public code: string, message: string, public status = 422, public retryable = false) { super(message); }
}
export const unitSchema = z.object({ id: z.string().min(1).max(80), wordIds: z.array(z.string().min(1).max(80)).min(1).max(40), text: z.string().trim().min(1).max(400) });
export const spansSchema = z.object({ spans: z.array(z.object({ fromWord: z.string(), toWord: z.string() })).min(1).max(2000) });
