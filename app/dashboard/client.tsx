"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import styles from "./dashboard.module.css";

type Msg = { role: "user" | "lucy"; text: string; meta?: string };

const STARTERS = [
  "How am I doing?",
  "/status",
  "Make cards for my last lesson",
  "What's the difference between 了 and 过?",
];

/** State a single optimistic write can be in. */
type WriteState = "idle" | "busy" | "done" | "failed";

/**
 * Hanzi runs inside otherwise-English text, wrapped so a screen reader switches voice for them.
 * The document is `lang="en"` (correct — the UI and Lucy's coaching are English), which makes
 * unmarked 学习 read out as English letters or get skipped. Chat text is model output, so the runs
 * can't be marked at authoring time; they're found here instead. CJK ideographs + CJK punctuation
 * only — pinyin is Latin and stays in the English run where it belongs.
 */
const CJK_RUN = /([\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF01-\uFF65]+)/g;

export function markHanzi(text: string): ReactNode[] {
  return text.split(CJK_RUN).map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} lang="zh-Hans">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

/**
 * Shared POST for the two dashboard writes. Returns null on success, else a message to show on the
 * row itself — a write that fails must say so where it failed, not in a global toast the learner
 * has already scrolled past.
 */
function usePost() {
  const router = useRouter();
  return useCallback(
    async (url: string, body: unknown): Promise<string | null> => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.status === 401) {
          router.replace("/login");
          router.refresh();
          return "Session expired — signing you back in.";
        }
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          return data.error ?? `Didn't save (${res.status}).`;
        }
        return null;
      } catch {
        return "No network — this didn't save.";
      }
    },
    [router],
  );
}

// ---- Today's plan -----------------------------------------------------------

export type PlanBlockView = { id: string; text: string; minutes: number | null };

/**
 * The checkable plan. Each row is one real button with role="checkbox": ticking it POSTs to
 * /api/dashboard/plan, which writes the same evidence texting Lucy "did it" would. The tick lands
 * immediately and rolls back with an inline reason if the write fails.
 *
 * `completedIds` is what makes a tick survive a reload: this component holds only the OPTIMISTIC
 * state of writes made in this page's lifetime, and the server-rendered list of blocks already
 * logged today is the durable half. Seeding local state from it (rather than reading it on every
 * render) keeps one source of truth per row: once the learner has touched a row, the local state
 * wins, so a tick can't visually un-tick itself against a prop that hasn't refreshed yet.
 */
export function PlanChecklist({
  blocks,
  completedIds = [],
}: {
  blocks: PlanBlockView[];
  completedIds?: string[];
}) {
  const post = usePost();
  const seed = useMemo(() => {
    const s: Record<string, WriteState> = {};
    for (const id of completedIds) s[id] = "done";
    return s;
  }, [completedIds]);
  const [state, setState] = useState<Record<string, WriteState>>(seed);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // What the always-mounted live region below says. A tick is otherwise a purely visual event.
  const [announce, setAnnounce] = useState("");

  // A router.refresh() (or a plain re-render after new data arrives) can hand us a longer done-set
  // than we started with — fold it in without clobbering rows the learner has since touched.
  useEffect(() => {
    setState((s) => {
      const missing = Object.keys(seed).filter((id) => !s[id]);
      return missing.length ? { ...s, ...Object.fromEntries(missing.map((id) => [id, "done" as WriteState])) } : s;
    });
  }, [seed]);

  async function tick(block: PlanBlockView) {
    const id = block.id;
    const current = state[id] ?? "idle";
    if (current === "busy" || current === "done") return;
    setState((s) => ({ ...s, [id]: "busy" }));
    setErrors((e) => ({ ...e, [id]: "" }));
    const err = await post("/api/dashboard/plan", { blockId: id });
    if (err) {
      setState((s) => ({ ...s, [id]: "failed" }));
      setErrors((e) => ({ ...e, [id]: err }));
      setAnnounce(`Couldn't log ${block.text}. ${err}`);
      return;
    }
    setState((s) => ({ ...s, [id]: "done" }));
    setAnnounce(`Logged ${block.text}.`);
  }

  return (
    <ul className={styles.taskList}>
      {blocks.map((b) => {
        const st = state[b.id] ?? "idle";
        const checked = st === "done" || st === "busy"; // optimistic: busy already reads as ticked
        const err = errors[b.id];
        return (
          <li key={b.id} className={styles.taskItem}>
            <button
              type="button"
              role="checkbox"
              aria-checked={checked}
              aria-disabled={st === "done" || st === "busy"}
              className={styles.task}
              onClick={() => tick(b)}
            >
              <span className={`${styles.taskBox} ${st === "busy" ? styles.taskBusy : ""}`} aria-hidden>
                {checked ? "[x]" : "[ ]"}
              </span>
              <span className={styles.taskText}>{markHanzi(b.text)}</span>
              {b.minutes ? <span className={styles.taskMin}>{b.minutes}m</span> : <span />}
            </button>
            {err ? <p className={styles.taskError}>{err} Tap again to retry.</p> : null}
          </li>
        );
      })}
      {/* The visible message above sits on the row that failed, which is where it belongs — but it
          only exists once the failure has happened, and a live region born with its text is often
          never announced. This one is mounted from first render and empty until there is news. */}
      <li className={styles.srOnly} role="status" aria-live="polite">
        {announce}
      </li>
    </ul>
  );
}

// ---- Open assignments -------------------------------------------------------

export type AssignmentView = {
  id: string;
  kind: string;
  description: string;
  daysCarried: number;
};

/** Open assignments with a real close control. Closing writes through /api/dashboard/assignment. */
export function AssignmentList({ items }: { items: AssignmentView[] }) {
  const post = usePost();
  const [state, setState] = useState<Record<string, WriteState>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [announce, setAnnounce] = useState("");

  async function close(item: AssignmentView) {
    const id = item.id;
    if ((state[id] ?? "idle") === "busy") return;
    setState((s) => ({ ...s, [id]: "busy" }));
    setErrors((e) => ({ ...e, [id]: "" }));
    const err = await post("/api/dashboard/assignment", { id });
    if (err) {
      setState((s) => ({ ...s, [id]: "failed" }));
      setErrors((e) => ({ ...e, [id]: err }));
      setAnnounce(`Couldn't close ${item.description}. ${err}`);
      return;
    }
    setState((s) => ({ ...s, [id]: "done" }));
    setAnnounce(`Closed ${item.description}.`);
  }

  return (
    <div>
      {items.map((a) => {
        const st = state[a.id] ?? "idle";
        const done = st === "done" || st === "busy";
        const err = errors[a.id];
        return (
          <div key={a.id} className={styles.asgRow}>
            <span className={`${styles.asgAge} ${a.daysCarried >= 3 ? styles.asgAgeHot : ""}`}>
              {a.daysCarried === 0 ? "today" : `D+${a.daysCarried}`}
              <span className={styles.asgKind}>{a.kind || "task"}</span>
            </span>
            <span className={`${styles.asgText} ${done ? styles.asgDone : ""}`}>{markHanzi(a.description)}</span>
            <button
              type="button"
              className={styles.btn}
              disabled={done}
              onClick={() => close(a)}
            >
              {st === "busy" ? "Closing…" : st === "done" ? "Closed" : "Close"}
            </button>
            {err ? <p className={styles.rowError}>{err} Press Close to retry.</p> : null}
          </div>
        );
      })}
      {/* Always-mounted announcer — same reasoning as the plan checklist's. */}
      <p className={styles.srOnly} role="status" aria-live="polite">
        {announce}
      </p>
    </div>
  );
}

// ---- Chat -------------------------------------------------------------------

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
    <div>
      <div className={styles.chips}>
        {STARTERS.map((s) => (
          <button key={s} type="button" className={styles.btn} onClick={() => send(s)} disabled={busy}>
            {s}
          </button>
        ))}
      </div>
      {/* role="log" + aria-live make Lucy's replies announce themselves as they land: without it the
          only feedback for a screen-reader user was that focus stayed in an emptied textarea. The
          region is present from first render (a live region added at the same time as its content is
          usually missed), and polite so a reply never interrupts what the learner is reading.
          tabindex=0 because the log is a capped scroll box with nothing focusable inside it — a
          keyboard user has no other way to scroll back through it. */}
      <div
        className={styles.chatLog}
        ref={logRef}
        tabIndex={0}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-label="Conversation with Lucy"
      >
        {messages.map((m, i) => (
          <div key={i} className={`${styles.msg} ${m.role === "user" ? styles.msgUser : styles.msgLucy}`}>
            {markHanzi(m.text)}
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
          aria-label="Message Lucy"
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
      type="button"
      className={styles.btn}
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
