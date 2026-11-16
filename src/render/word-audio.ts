import type { Interval } from "./speech";
import { overlap } from "./speech";
import type { MappedWord, Range } from "./edit-map";

const sampleRate = 16000, stride = 4, minimumCorrelation = .65;
function energy(samples: Float32Array, start: number, count: number) {
  let sum = 0; for (let i = 0; i < count; i += stride) sum += (samples[start + i] || 0) ** 2;
  return sum / Math.max(1, Math.ceil(count / stride));
}
function compare(source: Float32Array, output: Float32Array, sourceStart: number, outputStart: number, count: number) {
  const average = (samples: Float32Array, i: number) => ((samples[i] || 0) + (samples[i + 1] || 0) + (samples[i + 2] || 0) + (samples[i + 3] || 0)) / 4;
  const x: number[] = []; for (let i = 0; i < count; i += stride) x.push(average(source, sourceStart + i));
  const mean = x.reduce((a, b) => a + b, 0) / x.length, centered = x.map(v => v - mean), sourceEnergy = centered.reduce((a, v) => a + v * v, 0);
  let best = { correlation: 0, offsetMs: 0, levelChangeDb: Infinity };
  for (let shift = -480; shift <= 480; shift++) { // 1-sample precision, at most 30 ms codec alignment tolerance.
    const offset = outputStart + shift; if (offset < 0 || offset + count >= output.length) continue;
    let sum = 0, sumSquares = 0, dot = 0;
    for (let i = 0; i < centered.length; i++) { const value = average(output, offset + i * stride); sum += value; sumSquares += value * value; dot += centered[i] * value; }
    const outputEnergy = Math.max(0, sumSquares - sum * sum / centered.length), denominator = Math.sqrt(sourceEnergy * outputEnergy);
    const correlation = denominator > 1e-20 ? dot / denominator : 0;
    if (correlation > best.correlation) best = { correlation, offsetMs: shift / sampleRate * 1000, levelChangeDb: 10 * Math.log10(Math.max(1e-20, outputEnergy) / Math.max(1e-20, sourceEnergy)) };
  }
  return best;
}

export async function verifyWordAudio(source: Float32Array, output: Float32Array, map: { words: MappedWord[]; ranges: Range[] }, evidence: Interval[], thresholdDb: number, signal: AbortSignal) {
  const checks: { id: string; passed: boolean; probes: number; minCorrelation: number; maxLevelChangeDb: number; maxOffsetMs: number; missingEvidenceSeconds: number }[] = [];
  for (const word of map.words) {
    signal.throwIfAborted();
    const bounds = { start: word.startMs / 1000, end: word.endMs / 1000 };
    const measured = evidence.map(p => ({ start: Math.max(p.start, bounds.start), end: Math.min(p.end, bounds.end) })).filter(p => p.end - p.start >= .005);
    const missing = measured.reduce((sum, p) => sum + Math.max(0, p.end - p.start - map.ranges.reduce((n, r) => n + overlap(r, p), 0)), 0);
    const candidates: { sourceStart: number; outputStart: number; count: number; power: number }[] = [];
    for (const range of map.ranges) {
      const start = Math.max(word.acousticStart, range.start), end = Math.min(word.acousticEnd, range.end);
      if (end - start < .005) continue;
      const length = Math.min(.064, end - start);
      for (let t = start; t <= end - length + .00001; t += .032) {
        const sourceStart = Math.round(t * sampleRate), count = Math.round(length * sampleRate);
        candidates.push({ sourceStart, count, outputStart: Math.round((range.outputStart + range.padBefore + t - range.start) * sampleRate), power: energy(source, sourceStart, count) });
      }
      const t = end - length, sourceStart = Math.round(t * sampleRate), count = Math.round(length * sampleRate);
      candidates.push({ sourceStart, count, outputStart: Math.round((range.outputStart + range.padBefore + t - range.start) * sampleRate), power: energy(source, sourceStart, count) });
    }
    const audible = candidates.filter(p => 10 * Math.log10(p.power + 1e-15) >= thresholdDb - 3).sort((a, b) => a.sourceStart - b.sourceStart);
    const strongest = [...audible].sort((a, b) => b.power - a.power)[0];
    const probes = [...new Set([audible[0], strongest, audible.at(-1)].filter((p): p is NonNullable<typeof p> => !!p))];
    const results = probes.map(p => compare(source, output, p.sourceStart, p.outputStart, p.count));
    const minCorrelation = results.length ? Math.min(...results.map(r => r.correlation)) : 0;
    const maxLevelChangeDb = results.length ? Math.max(...results.map(r => Math.abs(r.levelChangeDb))) : 999;
    checks.push({ id: word.id, passed: missing < .002 && probes.length > 0 && minCorrelation >= minimumCorrelation && maxLevelChangeDb <= 6,
      probes: probes.length, minCorrelation, maxLevelChangeDb, maxOffsetMs: Math.max(0, ...results.map(r => Math.abs(r.offsetMs))), missingEvidenceSeconds: missing });
    if (checks.length % 8 === 0) await new Promise<void>(resolve => setImmediate(resolve));
  }
  return { passed: checks.every(c => c.passed), verifiedWords: checks.filter(c => c.passed).length, wordCount: map.words.length,
    minCorrelation: Math.min(1, ...checks.map(c => c.minCorrelation)), maxLevelChangeDb: Math.max(0, ...checks.map(c => c.maxLevelChangeDb)),
    maxOffsetMs: Math.max(0, ...checks.map(c => c.maxOffsetMs)), checks };
}
