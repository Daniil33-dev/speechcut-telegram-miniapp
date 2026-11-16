import { openSync, type Font } from "fontkit";
import type { ScriptUnit } from "../core/domain";
import type { MappedWord } from "./edit-map";
import { AppError } from "../core/domain";

const assTime = (s: number) => { const cs = Math.max(0, Math.round(s * 100)); return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`; };
const escapeAss = (s: string) => s.replace(/\\/g, "＼").replace(/{/g, "｛").replace(/}/g, "｝").replace(/[\r\n]/g, " ");
export function makeCaptions(units: ScriptUnit[], words: MappedWord[], width: number, height: number, position: number, fontPath: string) {
  const font = openSync(fontPath) as Font, fontSize = Math.max(16, Math.round(Math.min(width * 0.06, height * 0.045))), outline = Math.max(1, width / 360);
  const margin = Math.ceil(width * 0.1 + outline * 2), maxWidth = width - 2 * margin;
  const measure = (text: string, size = fontSize) => font.layout(text).positions.reduce((n, p) => n + p.xAdvance, 0) * size / font.unitsPerEm;
  const mapped = new Map(words.map(w => [w.id, w]));
  const cues: { start: number; end: number; lines: string[]; fontSize: number; measuredWidths: number[] }[] = [];
  let pending: ScriptUnit[] = [];
  function flush() {
    if (!pending.length) return;
    const start = mapped.get(pending[0].wordIds[0])!.outputStart, end = mapped.get(pending.at(-1)!.wordIds.at(-1)!)!.outputEnd;
    const texts = pending.map(u => u.text), lines: string[] = [""]; let size = fontSize;
    for (const text of texts) {
      const line = lines.at(-1)!, candidate = line ? `${line} ${text}` : text;
      if (measure(candidate) <= maxWidth) lines[lines.length - 1] = candidate;
      else if (lines.length < 2 && line) lines.push(text);
      else if (!line) lines[lines.length - 1] = text;
      else throw new AppError("CAPTION_TOO_WIDE", "Фраза субтитров слишком длинная. Сократите написание длинного слова.");
    }
    const widest = Math.max(...lines.map(l => measure(l)));
    if (widest > maxWidth) size = Math.floor(fontSize * maxWidth / widest);
    if (size < Math.min(12, fontSize)) throw new AppError("CAPTION_TOO_WIDE", "Название слишком длинное для читаемого субтитра.");
    cues.push({ start, end, lines, fontSize: size, measuredWidths: lines.map(l => measure(l, size)) }); pending = [];
  }
  for (const unit of units) {
    const proposed = [...pending, unit].map(u => u.text).join(" ");
    const previous = pending.at(-1), currentWord = mapped.get(unit.wordIds[0])!;
    const gap = previous ? currentWord.outputStart - mapped.get(previous.wordIds.at(-1)!)!.outputEnd : 0;
    if (pending.length && (pending.length >= 5 || measure(proposed) > maxWidth * 1.5 || gap > 0.5)) flush();
    pending.push(unit);
    if (/[.!?…]$/.test(unit.text)) flush();
  }
  flush();
  const y = Math.round(height * position / 100);
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Default,${font.familyName},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,${outline},0,5,${margin},${margin},0,1\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n`;
  return { cues, ass: header + cues.map(c => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,{\\pos(${Math.round(width / 2)},${y})\\fs${c.fontSize}}${c.lines.map(escapeAss).join("\\N")}`).join("\n") + "\n" };
}
