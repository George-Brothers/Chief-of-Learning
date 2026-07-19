export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 40, maxWidth: 640, lineHeight: 1.6 }}>
      <h1>Lucy</h1>
      <p>Chinese coach backend. Talk to Lucy on Telegram, or open your web dashboard.</p>
      <p>
        <a
          href="/dashboard"
          style={{
            display: "inline-block",
            marginTop: 8,
            padding: "10px 18px",
            borderRadius: 12,
            background: "#0f9d6b",
            color: "#fff",
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          Open dashboard →
        </a>
      </p>
    </main>
  );
}
