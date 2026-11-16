"use client";
import { useEffect, useRef, useState } from "react";
import type { Settings } from "@/core/domain";
export function SubtitlePreview({ url, width, height, settings, text }: { url: string; width: number; height: number; settings: Settings; text: string }) {
  const box = useRef<HTMLDivElement>(null); const [fontSize, setFontSize] = useState(20);
  useEffect(() => {
    if (!box.current) return;
    const resize = () => {
      const renderedWidth = box.current!.clientWidth, originalSize = Math.max(16, Math.round(Math.min(width * .06, height * .045)));
      const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d");
      let size = originalSize * renderedWidth / width;
      if (ctx) { ctx.font = `700 ${size}px VideoCaptions`; const measured = ctx.measureText(text).width; size *= Math.min(1, renderedWidth * .75 / Math.max(measured, 1)); }
      setFontSize(size);
    };
    const observer = new ResizeObserver(resize); observer.observe(box.current); void document.fonts.ready.then(resize); resize(); return () => observer.disconnect();
  }, [width, height, text]);
  return <figure className="subtitle-preview"><div ref={box} className="preview-frame" style={{ aspectRatio: `${width}/${height}`, width: `min(100%, ${60 * width / height}vh)` }}><video src={url} controls playsInline preload="metadata" />
    {settings.subtitles && <span className="preview-caption" style={{ top: `${settings.subtitlePosition}%`, fontSize }}>{text}</span>}</div><figcaption>Предпросмотр оформления на исходном видео</figcaption></figure>;
}
