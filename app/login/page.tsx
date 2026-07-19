"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import styles from "../dashboard/dashboard.module.css";

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        router.replace("/dashboard");
        router.refresh();
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "Login failed.");
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.loginWrap}>
        <div className={styles.loginCard}>
          <div className={styles.seal} style={{ margin: "0 auto", width: 52, height: 52, fontSize: 26 }} aria-hidden>
            露
          </div>
          <h1>Lucy · 学习中文</h1>
          <p>Sign in to your learning command center.</p>
          <form className={styles.loginForm} onSubmit={submit}>
            <input
              className={styles.loginInput}
              type="password"
              autoFocus
              value={password}
              placeholder="Dashboard password"
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
            <div className={styles.loginError}>{error}</div>
            <button className={styles.send} type="submit" disabled={busy || !password}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
