import { createHash } from "node:crypto";
import { AppError, type ScriptUnit, type Word } from "./domain";

export function contentHash(units: ScriptUnit[]) { return createHash("sha256").update(JSON.stringify(units)).digest("hex"); }
export function documentText(units: ScriptUnit[]) { return units.map(u => u.text).join(" "); }
export function wordIds(units: ScriptUnit[]) { return units.flatMap(u => u.wordIds); }

export function validateUnits(units: ScriptUnit[], words: Word[], allowedIds = words.map(w => w.id)) {
  if (!units.length) throw new AppError("EMPTY_SCRIPT", "В сценарии должна остаться хотя бы одна фраза.");
  const indexes = new Map(words.map((w, i) => [w.id, i]));
  const allowed = new Set(allowedIds), used = new Set<string>();
  for (const unit of units) {
    if (!unit.text.trim() || !unit.wordIds.length || unit.text.length > 400) throw new AppError("INVALID_SCRIPT", "Некорректное слово сценария.");
    let previous = -2;
    for (const id of unit.wordIds) {
      const index = indexes.get(id);
      if (index === undefined || !allowed.has(id) || used.has(id)) throw new AppError("INVALID_PLAN", "План содержит недоступное или повторяющееся слово.");
      if (previous !== -2 && index !== previous + 1) throw new AppError("INVALID_PLAN", "Название объединяет несмежные слова.");
      previous = index; used.add(id);
    }
    if (unit.id !== unit.wordIds[0]) throw new AppError("INVALID_SCRIPT", "Неверная привязка текста к речи.");
  }
}

// Manual editing can delete and correct units; their source identities and order
// are never reconstructed by matching text, even for repeated identical words.
export function validateManualEdit(next: ScriptUnit[], parent: ScriptUnit[], words: Word[]) {
  validateUnits(next, words, wordIds(parent));
  const positions = new Map(parent.map((u, i) => [u.id, i]));
  let previous = -1;
  for (const unit of next) {
    const index = positions.get(unit.id), original = index === undefined ? null : parent[index];
    if (!original || index! <= previous || JSON.stringify(unit.wordIds) !== JSON.stringify(original.wordIds))
      throw new AppError("AMBIGUOUS_EDIT", "Не удалось связать вставку с исходной речью. Для переноса фразы используйте запрос ИИ; написание исправляйте внутри существующих слов.");
    if (unit.text.trim().split(/\s+/).length > Math.max(original.wordIds.length, original.text.trim().split(/\s+/).length))
      throw new AppError("AMBIGUOUS_EDIT", "Новая фраза не может быть произнесена без исходного звука. Исправьте написание существующих слов.");
    previous = index!;
  }
}

export function applySpans(spans: { fromWord: string; toWord: string }[], parent: ScriptUnit[], words: Word[]) {
  const positions = new Map(words.map((w, i) => [w.id, i]));
  const available = new Set(wordIds(parent));
  const byWord = new Map(parent.flatMap(u => u.wordIds.map(id => [id, u] as const)));
  const result: ScriptUnit[] = [], used = new Set<string>();
  for (const span of spans) {
    const first = positions.get(span.fromWord), last = positions.get(span.toWord);
    if (first === undefined || last === undefined || first > last) throw new AppError("INVALID_PLAN", "ИИ вернул неизвестные границы фразы.");
    const ids = words.slice(first, last + 1).map(w => w.id);
    for (const id of ids) {
      if (!available.has(id) || used.has(id)) throw new AppError("INVALID_PLAN", "ИИ вернул удалённую или повторяющуюся фразу.");
      used.add(id);
    }
    const units = [...new Map(ids.map(id => [byWord.get(id)!.id, byWord.get(id)!])).values()];
    if (units.some(u => u.wordIds.some(id => !ids.includes(id)))) throw new AppError("INVALID_PLAN", "Нельзя разделить исправленное название при переносе.");
    result.push(...units);
  }
  validateUnits(result, words, [...available]);
  return result;
}

export function applyProofreading(groups: { wordIds: string[]; text: string }[], words: Word[]) {
  const original = groups.map(g => ({ id: g.wordIds[0], ...g }));
  validateUnits(original, words);
  if (JSON.stringify(wordIds(original)) !== JSON.stringify(words.map(w => w.id))) throw new AppError("INVALID_PROOFREAD", "Проверка текста изменила состав или порядок исходной речи.");
  const units = original.flatMap(group => {
    const tokens = group.text.trim().split(/\s+/);
    if (group.wordIds.length === 1 || tokens.length === 1) return [group];
    // Split only when each corrected token has exactly one ordered source ID.
    // Never guess timings or assign a shorter rewritten phrase proportionally.
    if (tokens.length !== group.wordIds.length) throw new AppError("INVALID_PROOFREAD", "Не удалось связать исправленный текст с отдельными словами. Исходник сохранён; подготовку сценария можно повторить.", 422, true);
    return group.wordIds.map((id, i) => ({ id, wordIds: [id], text: tokens[i] }));
  });
  validateUnits(units, words);
  return units;
}
