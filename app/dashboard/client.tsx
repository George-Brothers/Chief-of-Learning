"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./dashboard.module.css";

type Msg = { role: "user" | "lucy"; text: string; meta?: string };

const STARTERS = [
  "How am I doing?",
  "/status",
  "Make cards for my last lesson",
  "What's the difference between 了 and 过?",
];

/** Talk-to-Lucy panel. Posts to /api/chat, which runs the real Telegram brain server-side. */
export function Chat() {
  const router = useRouter();
  const [messages, setMessages] = useState<Msg[]>([
    { role: "lucy", text: "嗨 (hāi)! I'm Lucy. Ask about your progress, request cards, or ask a Chinese question. 加油!" },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const scroll = () =>
    requestAnimationFrame(() => {
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    });

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", text: message }]);
    setBusy(true);
    scroll();
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (res.status === 401) {
        router.replace("/login");
        router.refresh();
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { reply?: string; handledAs?: string };
      const reply = data.reply ?? "Something broke on my end. Try again in a sec.";
      const meta = data.handledAs === "command" ? "handled a command" : undefined;
      setMessages((m) => [...m, { role: "lucy", text: reply, meta }]);
    } catch {
      setMessages((m) => [...m, { role: "lucy", text: "Network hiccup — try that again." }]);
    } finally {
      setBusy(false);
      scroll();
    }
  }

  return (
    <div className={styles.chatCard}>
      <p className={styles.chatHint}>Same brain as Telegram — real reads and writes to your Notion.</p>
      <div className={styles.chips}>
        {STARTERS.map((s) => (
          <button key={s} className={styles.chip} onClick={() => send(s)} disabled={busy}>
            {s}
          </button>
        ))}
      </div>
      <div className={styles.chatLog} ref={logRef}>
        {messages.map((m, i) => (
          <div key={i} className={`${styles.msg} ${m.role === "user" ? styles.msgUser : styles.msgLucy}`}>
            {m.text}
            {m.meta ? <div className={styles.msgMeta}>{m.meta}</div> : null}
          </div>
        ))}
        {busy ? <div className={`${styles.msg} ${styles.msgLucy}`}>Lucy is thinking…</div> : null}
      </div>
      <form
        className={styles.composer}
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <textarea
          className={styles.input}
          rows={1}
          value={input}
          placeholder="Talk to Lucy…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
          disabled={busy}
        />
        <button className={styles.send} type="submit" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

export function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={styles.ghostBtn}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
        router.replace("/login");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
