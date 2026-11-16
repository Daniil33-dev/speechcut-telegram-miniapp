"use client";
import { useEffect, useRef } from "react";
import type { ScriptUnit } from "@/core/domain";

export function ScriptEditor({ units, disabled, onChange, onError }: { units: ScriptUnit[]; disabled: boolean; onChange: (units: ScriptUnit[], text: string) => void; onError: (message: string, text: string) => void }) {
  const root = useRef<HTMLDivElement>(null), composing = useRef(false), initial = useRef(units);
  useEffect(() => {
    if (!root.current) return;
    root.current.replaceChildren();
    for (const unit of initial.current) {
      const span = document.createElement("span"); span.dataset.unitId = unit.id; span.textContent = unit.text;
      root.current.append(span, document.createTextNode(" "));
    }
  }, []);
  function readDocument() {
    const element = root.current!;
    if (composing.current) return;
    const originals = new Map(initial.current.map(u => [u.id, u])), seen = new Set<string>(), result: ScriptUnit[] = [];
    const text = element.innerText;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node.textContent?.trim() && !node.parentElement?.closest("[data-unit-id]")) {
        onError("Новый текст нельзя озвучить. Исправляйте написание внутри существующего слова или удаляйте фразы.", text); return;
      }
    }
    for (const span of element.querySelectorAll<HTMLElement>("[data-unit-id]")) {
      const original = originals.get(span.dataset.unitId || ""), value = span.innerText.trim();
      if (!value) continue;
      if (!original || seen.has(original.id) || value.split(/\s+/).length > Math.max(original.wordIds.length, original.text.split(/\s+/).length)) {
        onError("Вставка не связана однозначно с исходной речью. Отмените ввод или исправьте написание существующего слова.", text); return;
      }
      seen.add(original.id); result.push({ ...original, text: value });
    }
    if (!result.length) { onError("В сценарии должна остаться хотя бы одна фраза.", text); return; }
    onChange(result, text);
  }
  return <div ref={root} className="script-document" role="textbox" aria-label="Сценарий видео" aria-multiline="true" contentEditable={!disabled}
    suppressContentEditableWarning spellCheck onInput={readDocument}
    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; readDocument(); }}
    onPaste={event => {
      event.preventDefault();
      onError("Вставка нового текста не меняет речь. Для правок используйте существующие слова или запрос ИИ.", root.current?.innerText || "");
    }} />;
}
