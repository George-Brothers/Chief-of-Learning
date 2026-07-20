# Lucy: an adaptive Chinese study coach

Lucy is an AI coach for learning Mandarin. You talk to it in a Telegram thread: check-ins,
questions, homework photos, produces flashcards, and more. It diagnoses each lesson, keeps your plan and
knowledge base in Notion, turns new vocabulary into Pleco flashcard decks, and sends one short brief
every morning.

The interesting part is underneath. One reasoning pipeline serves every interface, so a fix lands
everywhere at once. Model routing is a single-file change. And because this is a live personal system
with no backups, the write paths are built to never lose data.

This repository is a working template. It ships with example study data so the pieces are legible, and
every personal value lives in environment variables and Notion documents you provide. No database is
required to run it; an optional Neon Postgres + pgvector index adds semantic retrieval (see
[Semantic retrieval index](#semantic-retrieval-index-optional)).

## It also comes with a dashboard (if you like that sort of thing)
### To-do List
<img width="582.5" height="445.5" alt="Screenshot 2026-07-19 235234" src="https://github.com/user-attachments/assets/e45218eb-3466-4d5f-a663-840a2868b242" />
### Character Coverage Data
<img width="566.5" height="322.5" alt="Screenshot 2026-07-19 235251" src="https://github.com/user-attachments/assets/4725277e-14b3-473c-862d-048cfa95948a" />
<img width="569" height="503" alt="Screenshot 2026-07-19 235356" src="https://github.com/user-attachments/assets/a798790b-4531-4129-b32a-bef047295d57" />
<img width="571" height="461" alt="Screenshot 2026-07-19 235415" src="https://github.com/user-attachments/assets/fbacade2-6b2c-4b55-9ecb-a830741b3eee" />
<img width="1046" height="558" alt="Screenshot 2026-07-19 235447" src="https://github.com/user-attachments/assets/96115c71-dbd6-4f93-a72f-2e60c69edff6" />



## How it works

- **Telegram bot** is the primary interface. Send check-ins, questions, homework photos, or SRS
  screenshots, and get replies in the same thread. The morning brief arrives here too.
- **Web dashboard** (`/dashboard`) is an optional single-user command center: HSK progress, streak and
  recent activity, study plan, focus areas, and a Talk-to-Lucy chat that runs the same reasoning
  pipeline as Telegram. It is gated by `DASHBOARD_PASSWORD` and stays locked when that is unset.
- **Notion** stores everything: an Evidence Inbox, a four-document brain (Knowledge Ledger, Study Map,
  Daily Log, Gradebook), a Syllabus Index, an HSK Scorecard, and a Decks archive. Plans and history
  live in documents you can read and edit directly, so the system stays legible without a custom UI.
- **Next.js app on Vercel** exposes the `POST /api/telegram` webhook, the `GET /api/daily-brief` cron,
  and the password-gated dashboard with its `POST /api/chat` endpoint.
- **A local agent** watches your note-taker's output folder for full lesson transcripts, pushes them to
  the cloud for distillation and Anki card creation, and drains a Notion-backed action queue.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the request flows and design choices.

## Notable engineering

A few decisions carry most of the system's weight. Each one is a single place to look.

- **One brain, three adapters.** The reasoning pipeline lives in `lib/` and never forks. Telegram, the
  morning cron, and the web dashboard are thin adapters that reply through a shared `Responder`
  (`lib/command.ts`), so the same handlers serve every surface and a fix reaches all three at once.
- **Role-based model routing in one file.** Calls are routed by role (chat, reason, classify, long,
  vision) to the cheapest capable model, with provider fallback and retry. Swapping a model or provider
  is an env var or a one-line edit in `lib/models.ts`. Providers are built lazily and fail closed per
  role: chat runs on DeepSeek alone, and vision runs Gemini when its key is set and falls back to
  OpenAI when it isn't, so a handwriting photo still works without a Google key.
- **Durability by construction.** With no backups, the write paths are built so a crash or a retry can
  never lose data. Document updates append the new content before deleting the old; the action queue
  only burns failures that can never succeed, so Anki being closed leaves the task queued to retry; and
  the transcript watcher parks failed pushes for replay while the cloud dedups on content hash. The
  invariants are documented in `CLAUDE.md` and covered by tests.
- **Fail-open retrieval.** The optional Neon + pgvector index is a rebuildable, one-way derivative of
  Notion, which stays the source of truth. When the index is unconfigured, empty, or unreachable,
  retrieval returns nothing and the bot falls back to Notion-only. Adding it cannot break the base
  system.
- **Offline HSK coverage.** The HSK 3.0 word and character bands are committed to the repo, so the
  scorecard computes exact per-band coverage with no network call at runtime.
- **Local-only audio.** The optional recorder transcribes lessons on your machine with whisper.cpp and
  sends only the distilled text to the cloud. Audio never leaves the laptop.
- **Fail-closed auth.** The dashboard and its chat API are single-user. The session cookie is an HMAC
  keyed by a server secret (`lib/auth.ts`), so it can't be forged and the raw password is never stored
  client-side.

## Tech stack

Next.js (App Router) and TypeScript, the Vercel AI SDK with direct providers (`@ai-sdk/deepseek`,
`@ai-sdk/google`, and `@ai-sdk/openai` for embeddings), the Notion API, an optional Neon Postgres +
pgvector retrieval index (`@neondatabase/serverless`), the Telegram Bot API, Vercel Cron, Zod for
schemas, and Vitest for tests.

## Local development

```bash
npm install
npm test          # run the full suite
npm run build     # production build
```

Copy `.env.example` to `.env.local` and fill in your own values. The real file is gitignored, so no
secrets are committed.

## Setup

You need a Telegram bot, a Notion workspace, a DeepSeek API key (`DEEPSEEK_API_KEY`; optionally a
Google/Gemini key, `GOOGLE_GENERATIVE_AI_API_KEY`, for the long-context and vision roles, or an
`OPENAI_API_KEY` that also doubles as the vision fallback), and a Vercel project.

1. **Telegram.** Create a bot with [@BotFather](https://t.me/BotFather) to get `TELEGRAM_BOT_TOKEN`.
   Set `TELEGRAM_ALLOWED_CHAT_ID` to your own chat id and `TELEGRAM_WEBHOOK_SECRET` to any long random
   string.
2. **Notion.** Create an integration, share a parent page with it, and set `NOTION_TOKEN`. Then create
   the databases and pages:
   ```bash
   npm run setup:notion  -- <PARENT_PAGE_ID>   # Evidence Inbox, Syllabus, Decks, Scorecard
   npm run seed:knowledge -- <PARENT_PAGE_ID>   # the four-document brain, seeded with example data
   ```
   Paste every printed id into `.env.local` and your Vercel project settings.
3. **HSK data (optional).** The committed dataset in `lib/hsk/` is ready to use. To rebuild it from
   raw word lists, drop the sources in `materials/hsk30/` and run `npm run build:hsk`.

## Lesson pipeline

The local agent watches your note-taker's output folder for full tutor-lesson transcripts, pushes them
to the cloud for distillation and Anki card creation, and drains a Notion-backed action queue. Setup:

1. `npm run setup:notion -- <PARENT_PAGE_ID>` now also prints `NOTION_LESSONS_DB_ID` and
   `NOTION_ACTIONQUEUE_DB_ID`. Paste both into `.env.local` and your Vercel project settings.
2. Set `AGENT_SECRET` (any long random string) in both Vercel and `.env.agent`.
3. Install AnkiConnect (Anki → Tools → Add-ons → code `2055492159`) and keep Anki open. From WSL,
   `ANKI_URL` targets the Windows host (`http://localhost:8765` works when Anki binds all interfaces;
   otherwise use the host IP).
4. `npm run agent` starts the watcher and executor.
5. Drop a `.txt`/`.vtt` transcript in `WATCH_DIR` and expect a new Lessons row in Notion, a queued
   `create_anki_cards` action that flips to `done`, and new cards in the `Chinese::Lessons` deck.
6. Trigger the brief (`curl -H "authorization: Bearer <CRON_SECRET>" https://<app>.vercel.app/api/daily-brief`)
   and expect post-lesson feedback prepended to the morning Telegram message.

**Auto-recording (optional).** Instead of dropping transcripts by hand, `npm run recorder`
(`agent/recorder/`, a separate process) watches a recordings folder, transcribes finished lessons
locally with whisper.cpp, and drops the `.srt` into `WATCH_DIR` for the agent above. Audio never leaves
the machine. Full Windows setup (OBS capture plus whisper.cpp) is in
[`docs/recording.md`](docs/recording.md).

## Semantic retrieval index (optional)

Lucy can index her Notion content into **Neon Postgres + pgvector** so live-question prompts pull only
the most relevant lesson, evidence, and history instead of stuffing the whole brain into context. It is
**additive and fail-open**: Notion stays the source of truth, and if the index is unconfigured, empty,
or unreachable the bot silently falls back to Notion-only behavior. Nothing breaks.

The index is a **rebuildable, one-way derivative** of Notion. There is no ORM; the schema is raw SQL in
[`db/schema.sql`](db/schema.sql) (all statements idempotent), applied by a minimal migration runner.

1. Provision a Neon Postgres database (e.g. via the Vercel Marketplace) and set `DATABASE_URL`.
2. Set `OPENAI_API_KEY`, used for embeddings (`text-embedding-3-small`, 1536 dims; direct call, no
   gateway) and, separately, as the vision-role fallback (`openai/gpt-4o-mini`) so handwriting photos
   still work when the Google key is absent. Optionally override the embedding model with
   `EMBEDDING_MODEL` (must stay 1536-dim).
3. `npm run db:migrate` creates the `vector` extension, the `content_pages` and `content_chunks`
   tables, and the HNSW cosine index.
4. `npm run sync:index` reads Notion (via the existing Notion client), chunks and embeds what changed,
   and upserts it. It is idempotent: re-running with unchanged content is a no-op, and sources removed
   from Notion are deleted from the index. Re-run or schedule it whenever Notion content changes.

## Keeping the agent always-on

The local agent needs to survive terminal close and reboot so it works while you're away. Use pm2:

1. `npm i -g pm2`, then `pm2 start ecosystem.config.cjs && pm2 save`.
2. `pm2 startup` and run the printed command so it relaunches on boot.
3. **WSL caveat:** WSL only runs while it has a live process. Enable **systemd in WSL**
   (`/etc/wsl.conf` → `[boot] systemd=true`) or add a Windows Task Scheduler entry that runs
   `wsl -d <distro> -- pm2 resurrect` at logon, so the agent is up whenever the PC is on.
4. Keep Anki open (AnkiConnect) for card creation to succeed. If Anki is closed the action is **not**
   burned: it stays queued and the agent retries every poll, so the cards land once you open Anki.
   Only a failure Anki will never accept (a payload it rejects) is marked `error`, and that sends a
   `⚠️` message. Successful card runs report back with a `✅`.
5. Confirm with `pm2 logs lucy-agent`.

**If the agent was down when a lesson landed**, it catches up. On startup it rescans `WATCH_DIR` for
files modified in the last 7 days and pushes any the cloud hasn't seen (deduped by content hash, so a
rescan can't duplicate a lesson). A push that still can't reach the cloud is parked in
`WATCH_DIR/.failed` (override with `FAILED_DIR`) and retried every 5 minutes, so a transcript is never
dropped silently.

## Deploy

```bash
npm i -g vercel
vercel link
# Add every variable from .env.example to the project (DEEPSEEK_API_KEY is required).
vercel deploy --prod
```

Register the Telegram webhook once, pointing at your deployed URL:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<app>.vercel.app/api/telegram&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

The morning brief runs on the schedule in `vercel.json`. Adjust the cron time and `TIMEZONE` to match
where you are.

## Smoke test

- Text the bot a check-in like "did 30 minutes, tones felt rough" and expect an acknowledgement plus a
  row in the Evidence Inbox.
- Ask a grammar question and expect a concise answer with no evidence stored.
- Send a Pleco SRS screenshot and expect a distilled summary, plus a deck file if there are new words.
- Trigger the brief manually and expect a Today post-it in Notion and a Telegram message:
  ```bash
  curl -H "authorization: Bearer <CRON_SECRET>" https://<app>.vercel.app/api/daily-brief
  ```

## License

MIT. See [LICENSE](LICENSE).
