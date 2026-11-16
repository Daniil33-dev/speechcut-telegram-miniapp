import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { AppError, spansSchema, type Word, type ScriptUnit, type Operation } from "../../core/domain";
import { applyProofreading, applySpans } from "../../core/script-document";
import { tokenCost, type TokenPricing } from "../../core/usage";
import { proofreadInstructions, editInstructions } from "../../config/editor-instructions";
import { proofreadSchema } from "../../core/proofread-schema";
import { config, requireSecret } from "../config";
import { Store } from "../store";

export interface LlmProvider {
  proofreadTranscript(words: Word[], operation: Operation, signal: AbortSignal): Promise<ScriptUnit[]>;
  proposeEdit(words: Word[], units: ScriptUnit[], request: string, operation: Operation, signal: AbortSignal): Promise<ScriptUnit[]>;
}
function pricing(): TokenPricing | null {
  const names = ["OPENAI_INPUT_USD_PER_MILLION", "OPENAI_CACHED_USD_PER_MILLION", "OPENAI_OUTPUT_USD_PER_MILLION"];
  const values = names.map(n => process.env[n]);
  if (values.some(v => !v || !Number.isFinite(Number(v)) || Number(v) < 0) || !process.env.OPENAI_PRICING_DATE) return null;
  const optionalRate = (name: string) => process.env[name] && Number.isFinite(Number(process.env[name])) && Number(process.env[name]) >= 0 ? Number(process.env[name]) : undefined;
  return { input: Number(values[0]), cached: Number(values[1]), output: Number(values[2]), write30m: optionalRate("OPENAI_CACHE_WRITE_USD_PER_MILLION"), write12h: optionalRate("OPENAI_CACHE_WRITE_12H_USD_PER_MILLION"), date: process.env.OPENAI_PRICING_DATE };
}
export class OpenAiProvider implements LlmProvider {
  private client: OpenAI;
  constructor(private store: Store) {
    if (!config().llmModel) throw new AppError("SERVICE_NOT_CONFIGURED", "Модель OpenAI ещё не выбрана.", 503);
    this.client = new OpenAI({ apiKey: requireSecret("OPENAI_API_KEY"), baseURL: "https://api.openai.com/v1", maxRetries: 0, timeout: 90000 });
  }
  private async structured<T>(schema: z.ZodType<T>, instructions: string, input: unknown, operation: Operation, kind: string, signal: AbortSignal): Promise<T> {
    this.store.assertActive(operation.id);
    try {
      const response = await this.client.responses.create({ model: config().llmModel, instructions,
        input: JSON.stringify(input), text: { format: zodTextFormat(schema, "editor_result") }, service_tier: "default", reasoning: { effort: "low" }, max_output_tokens: 14000, store: false }, { signal });
      const usage = response.usage;
      let rate = pricing();
      const writes = usage?.input_tokens_details?.cache_write_tokens || 0, writes12h = usage?.input_tokens_details?.cache_write_tokens_details?.ttl_12h_tokens || 0;
      if (rate && usage && config().llmModel === "gpt-6-luna" && usage.input_tokens > 272000) rate = { ...rate, input: rate.input * 2, cached: rate.cached * 2, write30m: rate.write30m === undefined ? undefined : rate.write30m * 2, write12h: rate.write12h === undefined ? undefined : rate.write12h * 2, output: rate.output * 1.5 };
      let cost: number | null = null;
      try { cost = usage ? tokenCost(usage.input_tokens, usage.input_tokens_details?.cached_tokens || 0, usage.output_tokens, rate, writes, writes12h) : null; } catch { /* Keep provider usage even when a new billing shape cannot be estimated. */ }
      this.store.recordUsage({ id: `openai:${response.id}`, jobId: operation.jobId, operationId: operation.id, providerRequestId: response.id,
        provider: "openai", model: response.model, kind, inputTokens: usage?.input_tokens || 0, cachedInputTokens: usage?.input_tokens_details?.cached_tokens || 0,
        cacheWriteTokens: writes, cacheWrite12hTokens: writes12h, outputTokens: usage?.output_tokens || 0, audioSeconds: 0,
        costUsd: cost,
        pricingVersion: rate ? `${response.model}:standard:${usage && usage.input_tokens > 272000 ? "long" : "short"}:${rate.date}` : null, costSource: cost === null ? "unknown" : "estimate", createdAt: Date.now() });
      this.store.assertActive(operation.id);
      if (response.status !== "completed" || !response.output_text) throw new AppError("INVALID_LLM_RESPONSE", "ИИ не закончил ответ. Сценарий сохранён; запрос можно повторить.", 422, true);
      let parsed: unknown;
      try { parsed = JSON.parse(response.output_text); } catch { throw new AppError("INVALID_LLM_RESPONSE", "ИИ вернул некорректный ответ. Предыдущий сценарий сохранён."); }
      const result = schema.safeParse(parsed);
      if (!result.success) throw new AppError("INVALID_LLM_RESPONSE", "Ответ ИИ не прошёл проверку. Предыдущий сценарий сохранён.");
      return result.data;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof OpenAI.APIError) {
        if ([402, 429].includes(error.status || 0)) throw new AppError("LLM_QUOTA", "Достигнут лимит OpenAI или закончились API-кредиты. Сценарий и готовые видео сохранены.", 429, false);
        if ([401, 403].includes(error.status || 0)) throw new AppError("LLM_ACCESS", "Проверьте доступ OpenAI и API-ключ.", 503);
      }
      if (signal.aborted) throw new AppError("CANCELLED", "Обработка отменена.", 409);
      throw new AppError("LLM_UNAVAILABLE", "OpenAI временно недоступен. Повтор после сетевого сбоя может создать ещё один оплачиваемый запрос.", 503, true);
    }
  }
  async proofreadTranscript(words: Word[], operation: Operation, signal: AbortSignal) {
    const saved = (this.store.operation(operation.id).checkpoint.proofreadChunks || []) as ScriptUnit[][];
    const chunks: ScriptUnit[][] = [...saved];
    for (let offset = chunks.length * 220; offset < words.length; offset += 220) {
      const batch = words.slice(offset, offset + 220);
      const response = await this.structured(proofreadSchema, proofreadInstructions, { words: batch }, operation, "proofread", signal);
      const units = applyProofreading(response.groups, batch);
      chunks.push(units);
      this.store.checkpoint(operation.id, { proofreadChunks: chunks }, "Проверяем текст");
    }
    const units = chunks.flat();
    applyProofreading(units.map(u => ({ wordIds: u.wordIds, text: u.text })), words);
    return units;
  }
  async proposeEdit(words: Word[], units: ScriptUnit[], request: string, operation: Operation, signal: AbortSignal) {
    if (JSON.stringify(units).length > 350000) throw new AppError("SCRIPT_TOO_LARGE", "Сценарий слишком велик для одного запроса. Удалите лишние части вручную.");
    const response = await this.structured(spansSchema, editInstructions, { request, script: units, availableWords: units.flatMap(u => u.wordIds).map(id => words.find(w => w.id === id)) }, operation, "edit", signal);
    return applySpans(response.spans, units, words);
  }
}
