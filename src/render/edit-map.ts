import { AppError, type Word, type ScriptUnit, type Settings } from "../core/domain";
import { wordIds } from "../core/script-document";
import { overlap, type Interval } from "./speech";

export const RENDER_REVISION = "2026-11-16-quiet-speech-1";
export type Range = Interval & { outputStart: number; outputEnd: number; padBefore: number; padAfter: number };
export type MappedWord = Word & { acousticStart: number; acousticEnd: number; outputStart: number; outputEnd: number };
export function fitWord(word: Word, active: Interval[]): Interval {
  const search = { start: word.startMs / 1000, end: word.endMs / 1000 };
  const pieces = active.map(a => ({ start: Math.max(a.start, search.start), end: Math.min(a.end, search.end) })).filter(p => p.end - p.start >= 0.005);
  if (!pieces.length) throw new AppError("WORD_CHECK_FAILED", "Не удалось безопасно определить границы одного из слов. Нужна проверка записи.");
  return { start: pieces[0].start, end: pieces.at(-1)!.end };
}
export function buildEditMap(words: Word[], units: ScriptUnit[], settings: Settings, total: number, active: Interval[], pauses: Interval[]) {
  const selected = wordIds(units), positions = new Map(words.map((w, i) => [w.id, i]));
  const fitted = new Map<string, Interval>();
  for (const id of selected) { const word = words[positions.get(id)!]; if (!word) throw new AppError("WORD_CHECK_FAILED", "В сценарии найдено неизвестное слово."); fitted.set(id, fitWord(word, active)); }
  const groups: string[][] = [];
  for (const id of selected) { const previous = groups.at(-1); if (previous && positions.get(id) === positions.get(previous.at(-1)!)! + 1) previous.push(id); else groups.push([id]); }
  const ranges: Range[] = []; let output = 0;
  for (const group of groups) {
    const firstIndex = positions.get(group[0])!, lastIndex = positions.get(group.at(-1)!)!;
    const first = fitted.get(group[0])!, last = fitted.get(group.at(-1)!)!;
    // Source padding must not reintroduce a deleted neighboring word.
    const previousEnd = firstIndex > 0 ? Math.min(first.start, words[firstIndex - 1].endMs / 1000) : 0;
    const nextStart = lastIndex + 1 < words.length ? Math.max(last.end, words[lastIndex + 1].startMs / 1000) : total;
    const start = Math.max(0, first.start - 0.1, previousEnd), end = Math.min(total, last.end + 0.1, nextStart);
    const cuts = settings.removePauses ? pauses.map(p => ({ start: Math.max(start, p.start + 0.1), end: Math.min(end, p.end - 0.1) })).filter(p => p.end > p.start) : [];
    let cursor = start;
    const sourceRanges: Interval[] = [];
    for (const cut of cuts) { if (cut.start > cursor) sourceRanges.push({ start: cursor, end: cut.start }); cursor = Math.max(cursor, cut.end); }
    if (cursor < end) sourceRanges.push({ start: cursor, end });
    sourceRanges.forEach((sourceRange, i) => {
      const padBefore = i === 0 ? Math.max(0, 0.1 - (first.start - start)) : 0;
      const edgePad = i === sourceRanges.length - 1 ? Math.max(0, 0.1 - (end - last.end)) : 0;
      const baseDuration = sourceRange.end - sourceRange.start + padBefore + edgePad;
      const alignedDuration = Math.ceil((baseDuration - 1e-9) * 30) / 30;
      const range = { ...sourceRange, padBefore, padAfter: edgePad + alignedDuration - baseDuration, outputStart: output, outputEnd: output + alignedDuration };
      ranges.push(range); output = range.outputEnd;
    });
  }
  const mapped: MappedWord[] = selected.map(id => {
    const word = words[positions.get(id)!], acoustic = fitted.get(id)!;
    const matching = ranges.filter(r => overlap(r, acoustic) > 0.001);
    if (!matching.length) throw new AppError("WORD_CHECK_FAILED", "Монтаж потерял слово одобренного сценария.");
    // Reordered ranges can overlap in source time only if the plan duplicated a
    // word. The domain validator forbids that before this map is built.
    const startRange = matching.find(r => r.start <= acoustic.start + 0.002 && r.end > acoustic.start);
    const endRange = matching.find(r => r.start < acoustic.end && r.end >= acoustic.end - 0.002);
    if (!startRange || !endRange) throw new AppError("WORD_CHECK_FAILED", "Монтаж обрезал начало или окончание слова.");
    return { ...word, acousticStart: acoustic.start, acousticEnd: acoustic.end,
      outputStart: startRange.outputStart + startRange.padBefore + Math.max(0, acoustic.start - startRange.start),
      outputEnd: endRange.outputStart + endRange.padBefore + Math.min(endRange.end - endRange.start, acoustic.end - endRange.start) };
  });
  return { rendererRevision: RENDER_REVISION, ranges, words: mapped, duration: output, pauseAudit: pauses, selectedWordIds: selected };
}
