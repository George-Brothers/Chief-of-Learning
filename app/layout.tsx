import "./globals.css";

export const metadata = {
  title: "Lucy — Chinese Coach",
  description: "Adaptive Chinese learning coach backend.",
};

/**
 * `lang="en"` is correct for the document: the interface, and everything Lucy says about the
 * learner's progress, is English. The Chinese in the page is inline foreign text, so it is marked
 * per-run with `lang="zh-Hans"` at the point it is rendered (the callsign, lesson corrections and
 * headwords, and every hanzi run inside a chat message) rather than by mislabelling the whole
 * document — a screen reader given `lang="en"` for 学习中文 reads it as English and produces noise.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
