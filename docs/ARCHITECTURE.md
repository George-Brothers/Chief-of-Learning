# Architecture

Lucy is a small, single-user study coach. One learner talks to a Telegram bot or an optional web
dashboard, the system stores evidence and plans in Notion, and a scheduled job writes a short morning
brief. A language model does the reasoning. The system runs with no database; an optional Neon
Postgres + pgvector index adds semantic retrieval as a rebuildable, one-way derivative of Notion.

## Components

- **Telegram bot** is the primary interface. The learner sends check-ins, questions, homework photos,
  and SRS screenshots. Lucy replies in the same thread and delivers the morning brief here too.
- **Web dashboard** (`app/dashboard/`) is an optional single-user command center. `lib/dashboard.ts`
  assembles its view model — Notion reads plus the offline HSK engine, plus the parsing/shaping the
  page needs (e.g. `parseTodayPlan`); it performs no writes itself, but the dashboard as a whole is no
  longer read-only: it can tick off a plan block and close an assignment through two authenticated
  write endpoints (below), which land in the SAME Notion records the Telegram path writes. It also has
  a Talk-to-Lucy chat. Every interface reuses the same brain — the command layer replies through a
  `Responder` (`lib/command.ts`) that defaults to Telegram, so the web chat collects the same handler
  output into an HTTP response via the `lib/webchat.ts` adapter.
- **Notion** is the system of record. It holds an Evidence Inbox, a four-document "brain" (Knowledge
  Ledger, Study Map, Daily Log, Gradebook), a Syllabus Index, an HSK Scorecard, and a Decks archive.
- **Next.js app on Vercel** exposes:
  - `POST /api/telegram` is the inbound webhook for every message.
  - `GET /api/daily-brief` is the morning cron that composes and sends the brief.
  - `/dashboard` and `POST /api/chat` are the password-gated web surface (see Security).
  - `POST /api/dashboard/plan` ticks off a block of today's plan. It takes only a block id, re-reads
    the Today page and resolves the id there, then writes a check-in to the Evidence Inbox — so the
    stored text is always Lucy's own and a checked box is indistinguishable from texting "did it".
  - `POST /api/dashboard/assignment` closes an open assignment via the same `markAssignmentDone` the
    Telegram `/done` path uses, after checking the id against the currently-open set.
  - Both dashboard write routes are gated by the same session cookie as `/api/chat` (see Security).
- **Language model** distills evidence, updates the plan, answers questions, and extracts vocabulary.
  Calls hit the providers *directly* (`@ai-sdk/deepseek` keyed by `DEEPSEEK_API_KEY`, `@ai-sdk/google`
  keyed by `GOOGLE_GENERATIVE_AI_API_KEY`, `@ai-sdk/openai` keyed by `OPENAI_API_KEY`) and are routed
  by *role* (chat/reason/classify/long/vision) to the cheapest capable model, with provider fallback
  and retry. Providers are built lazily and fail closed per role: the chat/reason/classify path runs
  on DeepSeek alone, `long` falls back to DeepSeek without the Google key, and `vision` runs Gemini
  when the Google key is set and falls back to `openai/gpt-4o-mini` when it isn't — it fails closed
  (throws `NoProviderError`) only when neither Google nor OpenAI is wired, and the Telegram photo path
  catches that to degrade honestly instead of erroring. Routing is defined in one place
  (`lib/models.ts`, env-overridable via `MODEL_*` as `provider/model-id` slugs), so swapping a model
  or provider is an env or single-file change.
- **HSK dataset** (`lib/hsk/`) is a committed, offline copy of the HSK 3.0 word and character bands.
  The scorecard computes exact per-band coverage from it with no network call at runtime.
- **Listening inventory** (`lib/listening-sources.ts`) is committed offline data for the same reason:
  the daily brief picks 3 REAL named sources (budget-filtered, rotating past what was offered on the
  recent days) and the prompt may only offer those, so the coach cannot invent material. There is no
  HSK-level filter: every entry starts at HSK 1, so one would exclude nothing. The
  day's minute budget comes from `studyPlanShape()` in `lib/rhythm.ts`, not from the model.
- **Retrieval index (optional)** is a derived read index in Neon Postgres + pgvector. `lib/retrieval.ts`
  syncs Notion content one-way (chunk + embed via OpenAI `text-embedding-3-small`, keyed by
  `OPENAI_API_KEY`; direct call, no gateway) into the schema in `db/schema.sql`, and retrieves top-k
  chunks by cosine distance to scope live-question prompts. It is ADDITIVE and fail-open: Notion stays
  the source of truth, and when `DATABASE_URL` is unset, the index is empty, or the DB is unreachable,
  retrieval returns nothing and prompt assembly falls back to the Notion-only brain (`lib/brain.ts`).
  The storage layer is behind a `VectorStore` seam (`lib/vector-store.ts`) with a Neon and an in-memory
  implementation, so ingestion and ranking are unit-tested without a live database.

## Request flows

**Inbound message.** Telegram calls `/api/telegram`. The route verifies the shared secret header and
the allowed chat id, then a model classifier assigns the message one intent. Command intents (make
cards, feedback, status, listen) run their handler. An `answer` intent — any question, plan ask, or
small talk, question mark or not — is answered against the current brain context, scoped by the
retrieval index when it's configured, via `lib/brain.ts`. A `log` intent, or any photo, becomes
distilled evidence written to the Notion inbox. New tutor words go to ONE place: the Anki queue, via
`enqueueCards` (`lib/actions.ts`). No automatic path sends a Pleco file any more — a file to import is
homework, not a result — so the reply is a confirmation line built by `lib/agent-status.ts`, which
states whether the cards are merely queued or the local agent is actually up to write them. It never
says "in your Anki deck": only the agent's own report-back can say that. `lib/deck.ts` / `lib/pleco.ts`
are intact and reachable through the explicit `/pleco` command. `enqueueCards` is the single producer of `create_anki_cards` tasks — every path
that discovers vocab (transcript ingest, `/lesson`, `/cards`, lesson feedback, the photo/evidence
path and the daily brief) goes through it, so the de-dupe, the `example` fallback, `notify` and the
batch label are decided in one place. The classifier owns the answer-vs-file decision; the route never infers it from
punctuation. Filed evidence is acknowledged with what was actually understood, not a bare "Logged.".

**Cards reaching Anki.** Queued tasks are drained by the local agent (`agent/executor.ts`). Failure
handling is fail-safe by design, because closing a queue row is irreversible — `markActionDone(ok=false)`
writes Status "error" and `getQueuedActions` only ever returns "queued". So a failure is retried unless
it is *provably* permanent (`agent/failure.ts`); connectivity failures (Anki closed, laptop asleep)
retry without limit, anything unexplained gets `MAX_ATTEMPTS` tries, and a row is never closed without
first writing its cards to the on-disk dead letter (`parkCards`, `agent/deadletter.ts`). Within a batch
each note is isolated: one note Anki refuses is quarantined and reported, the rest still land. De-dupe
searches the whole `Chinese::*` deck tree, not just the destination deck, so the learner's pre-existing
lesson decks are seen; lesson/source structure is carried as Anki TAGS, never as deck names.

**Knowing whether the agent is alive.** Everything above is worthless if nothing drains the queue, and
for weeks nothing did — an agent that had never once run successfully looked exactly like a quiet week.
So the agent POSTs `/api/agent/heartbeat` after every successful poll cycle (throttled to `HEARTBEAT_MS`,
default 60s — optional, like every agent-side var), carrying its last AnkiConnect probe. The cloud
stamps *server* time and stores it as one self-updating row in the Action Queue database: Type
`agent_heartbeat`, Status `heartbeat`, so `getQueuedActions` — and therefore the agent's own task feed —
can never see it. No new env var, required or otherwise, was added to `lib/env.ts`; a new required one
would break the deployed app at boot, since `getEnv()` re-parses on every call.

That signal is then made impossible to miss, in code rather than in a prompt so it cannot be
paraphrased away or hallucinated: the morning brief leads with `agentDownAlert` when the agent has been
silent past `AGENT_ALERT_STALE_MS` (12h) **and** `create_anki_cards` rows are queued behind it — and
says nothing at all when the queue is empty, because a down agent with nothing waiting costs nothing
today. `queueErrorAlert` reports rows that ended in Status "error", which until now were written once
and read by nothing. The dashboard's Agent panel shows last check-in, AnkiConnect reachability and the
queued/errored counts. `/agent` reports the same from the phone and `/agent retry` re-queues burned
rows with their payloads intact (`requeueAction`), so a failed batch is recoverable instead of dead.

**Morning brief.** Vercel Cron calls `/api/daily-brief` with a bearer token. The route reads the brain
and recent evidence, asks the model for one calibrated action for the day, writes the Today post-it to
Notion, and sends it over Telegram. A weekly review runs on Sundays and refreshes the Gradebook.

**Web chat.** The dashboard posts to `/api/chat` with the session cookie. The route runs the same
command pipeline as Telegram through the `lib/webchat.ts` adapter, capturing the reply into the HTTP
response instead of sending it to Telegram. Dashboard reads fail soft, so one empty Notion document
never blanks the page.

## Design choices

- **One action per day.** The coach never piles new work on an unfinished task. Every drill stays at
  known words plus one or two new ones.
- **Notion as the brain.** Plans and history live in documents the learner can read and edit directly,
  so the system stays legible without a custom UI.
- **Committed HSK data.** Coverage math is deterministic and offline, so the cron path has no external
  dependency beyond the model call.

## Security

- The Telegram webhook checks the `X-Telegram-Bot-Api-Secret-Token` header and accepts only the
  configured chat id.
- The cron route requires an `Authorization: Bearer` token.
- The web dashboard, `/api/chat` and both dashboard write routes (`/api/dashboard/plan`,
  `/api/dashboard/assignment`) are single-user and fail closed: they are gated by
  `DASHBOARD_PASSWORD`, and when it is unset the dashboard stays locked. The session cookie stores an
  HMAC of the password keyed by `CRON_SECRET` (`lib/auth.ts`), so the raw password is never stored
  client-side and the token can't be forged without the server secret.
- All keys live in environment variables. Nothing sensitive is committed. See `.env.example`.
