import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";
export const metadata: Metadata = { title: "Монтаж видео", robots: { index: false, follow: false } };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Telegram sets viewport CSS variables on <html> before React hydrates.
  return <html lang="ru" suppressHydrationWarning><body>{children}<Script src="https://telegram.org/js/telegram-web-app.js" strategy="beforeInteractive" /></body></html>;
}
