export const metadata = {
  title: "Lucy — Chinese Coach",
  description: "Adaptive Chinese learning coach backend.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
