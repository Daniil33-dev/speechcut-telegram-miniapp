import type { UsageEvent } from "@/core/domain";

const operationNames: Record<string, string> = {
  asr: "Распознавание речи", transcribe: "Распознавание речи",
  proofread: "Проверка текста", edit: "Правка сценария",
};

export function ExpenseDetails({ events }: { events: UsageEvent[] }) {
  return <ol className="usage-list">{events.map(event => {
    const date = event.pricingVersion?.match(/\d{4}-\d{2}-\d{2}/)?.[0];
    return <li key={event.id}>
      <strong>{operationNames[event.kind] || "Обработка"} · {event.provider === "openai" ? "OpenAI" : "AssemblyAI"}</strong>
      <p className="muted">{event.model}</p>
      {event.provider === "assemblyai" ? <p>Обработано аудио: {event.audioSeconds.toLocaleString("ru-RU", { maximumFractionDigits: 2 })} с</p> : <>
        <p>Токены: вход {event.inputTokens.toLocaleString("ru-RU")} · выход {event.outputTokens.toLocaleString("ru-RU")}</p>
        <p className="muted">Из входных: чтение кэша {event.cachedInputTokens.toLocaleString("ru-RU")} · запись кэша {(event.cacheWriteTokens || 0).toLocaleString("ru-RU")}{event.cacheWrite12hTokens ? ` (12 ч: ${event.cacheWrite12hTokens.toLocaleString("ru-RU")})` : ""}. Эти токены уже входят во вход, повторно не начисляются.</p>
      </>}
      <p>{event.costUsd === null ? "Стоимость: тариф уточняется" : `Стоимость: ${event.costSource === "estimate" ? "≈ " : ""}$${event.costUsd.toFixed(6)}`}{date ? ` · тариф от ${date}` : ""}</p>
    </li>;
  })}</ol>;
}
