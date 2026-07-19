# Architecture

Lucy is a small, single-user study coach. One learner talks to a Telegram bot or an optional web
dashboard, the system stores evidence and plans in Notion, and a scheduled job writes a short morning
brief. A language model does the reasoning. The system runs with no database; an optional Neon
Postgres + pgvector index adds semantic retrieval as a rebuildable, one-way derivative of Notion.

## Components

- **Telegram bot** is the primary interface. The learner sends check-ins, questions, homework photos,
  and SRS screenshots. Lucy replies in the same thread and delivers the morning brief here too.
- **Web dashboard** (`app/dashboard/`) is an optional single-user command center rendered from a pure
  read layer (`lib/dashboard.ts`) over the Notion readers and the offline HSK engine, with a
  Talk-to-Lucy chat. Every interface reuses the same brain — the command layer replies through a
  `Responder` (`lib/command.ts`) that defaults to Telegram, so the web chat collects the same handler
  output into an HTTP response via the `lib/webchat.ts` adapter.
- **Notion** is the system of record. It holds an Evidence Inbox, a four-document "brain" (Knowledge
  Ledger, Study Map, Daily Log, Gradebook), a Syllabus Index, an HSK Scorecard, and a Decks archive.
- **Next.js app on Vercel** exposes:
  - `POST /api/telegram` is the inbound webhook for every message.
  - `GET /api/daily-brief` is the morning cron that composes and sends the brief.
  - `/dashboard` and `POST /api/chat` are the password-gated web surface (see Security).
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
the allowed chat id, then classifies the message. A photo or note becomes distilled evidence written
to the Notion inbox; new tutor words become a Pleco deck file the learner can import; a plain question
is answered against the current brain context — scoped by the retrieval index when it's configured,
via `lib/brain.ts`. Everything else is a short acknowledgement.

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
- The web dashboard and `/api/chat` are single-user and fail closed: they are gated by
  `DASHBOARD_PASSWORD`, and when it is unset the dashboard stays locked. The session cookie stores an
  HMAC of the password keyed by `CRON_SECRET` (`lib/auth.ts`), so the raw password is never stored
  client-side and the token can't be forged without the server secret.
- All keys live in environment variables. Nothing sensitive is committed. See `.env.example`.
