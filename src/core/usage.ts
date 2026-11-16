import type { UsageEvent } from "./domain";

export type TokenPricing = { input: number; cached: number; output: number; write30m?: number; write12h?: number; date: string };
export function tokenCost(input: number, cached: number, output: number, rate: TokenPricing | null, writes = 0, writes12h = 0) {
  if (!rate) return null;
  if (cached < 0 || cached + writes > input || input < 0 || output < 0 || writes12h < 0 || writes < writes12h) throw new Error("Invalid token usage");
  if ((writes > writes12h && rate.write30m === undefined) || (writes12h && rate.write12h === undefined)) return null;
  return ((input - cached - writes) * rate.input + cached * rate.cached + (writes - writes12h) * (rate.write30m || 0) + writes12h * (rate.write12h || 0) + output * rate.output) / 1e6;
}
export function summarizeUsage(events: UsageEvent[]) {
  return { knownUsd: events.reduce((n, e) => n + (e.costUsd ?? 0), 0), unknownEvents: events.filter(e => e.costUsd === null).length,
    estimated: events.some(e => e.costSource === "estimate"), infrastructureIncluded: false,
    hasUsage: events.length > 0 };
}
