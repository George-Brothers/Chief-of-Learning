# Auto-recording Preply lessons (Windows) → Lucy

Record 1:1 Mandarin lessons taken in the browser (Preply) and feed them into Lucy automatically, with
minimal friction. **Everything runs locally — audio never leaves the machine.** Only the distilled
transcript text is sent to Lucy's app, exactly as it is today for hand-dropped transcripts.

## The pipeline

```
Preply call (browser)
  ├─ tutor / remote voice  → played to speakers → WASAPI loopback ─┐
  └─ student (you) mic     → mic input          → WASAPI input ─────┤
                                                                    ▼
  [1] OBS Studio   — global hotkey Start/Stop — records one MKV into  RECORDINGS_DIR
                                                                    ▼  (a finished .mkv appears)
  [2] npm run recorder  (agent/recorder/, this repo)
        ffmpeg → 16 kHz mono WAV → whisper.cpp (-l zh) → <name>.srt (atomic) into  WATCH_DIR
        source recording archived (kept, never deleted)
                                                                    ▼  (a .srt lands in WATCH_DIR)
  [3] npm run agent  (agent/index.ts, unchanged)
        watches WATCH_DIR → distills the lesson in the cloud → auto-generates Anki cards
```

The recorder is a **separate process** from the ingest daemon so heavy transcription can't stall
ingest, and so the proven ingest path stays untouched. The daemon already accepts `.srt` and strips
its timestamps/cue-numbers (`agent/convert.ts`), so **no daemon change is needed** to consume this.

> **Trigger (v1):** a single OBS global hotkey to start/stop. The captain chose "proven recorder + our
> glue" over brittle fully-hands-free auto-detect. Fully-automatic call detection (audio-activated or
> Preply-tab detection) is a later enhancement.

## What can only be verified on the Windows machine

This was designed and unit-tested on Linux with **no audio hardware or browser**. Confirm on the PC:
1. **Both sides captured** — OBS "Desktop Audio" (loopback) carries the *tutor*, "Mic/Aux" the *student*.
2. **Watcher reliability** — run the agent + recorder **natively on Windows** (not WSL watching `/mnt/c`,
   where chokidar's inotify events are unreliable; the boot rescan papers over it but native is better).
3. **whisper.cpp build + speed** on the actual CPU/GPU; drop `large-v3-q5_0` → `medium` if too slow.
4. **Chinese + code-switching quality** — Whisper's code-switching WER is high regardless; try
   `WHISPER_LANG=auto` if `zh` garbles English-heavy stretches.
5. **Global hotkey** fires while OBS is minimized to tray and doesn't collide with a browser shortcut.

---

## Setup runbook (copy-paste; adjust drive letters)

### 1. Folders
```bat
mkdir C:\lucy\recordings
mkdir C:\lucy\transcripts        REM  <- WATCH_DIR
mkdir C:\lucy\bin
mkdir C:\lucy\models
```

### 2. OBS Studio (capture)
1. Install OBS Studio (obsproject.com); skip the auto-config wizard.
2. Audio Mixer → confirm **Desktop Audio** = the device the Preply call plays through (tutor), and
   **Mic/Aux** = your microphone (student). Settings → Audio if you need to pick devices.
3. Settings → Output → Output Mode **Advanced** → Recording:
   - Recording Format: **mkv** (crash-recoverable, unlike mp4).
   - Recording Path: `C:\lucy\recordings`.
   - Audio Track: **1** (both sources mixed into one track).
   - *(OBS has no clean audio-only mode; a small/black video track is fine — the recorder discards it
     with `ffmpeg -vn`, and the source is auto-archived after transcription.)*
4. Settings → Hotkeys → bind **Start Recording** and **Stop Recording** (e.g. `Ctrl+Alt+R`).
5. Settings → General → enable "Minimize to system tray".

### 3. Local transcriber (whisper.cpp + ffmpeg)
1. Put a prebuilt **whisper.cpp** `whisper-cli.exe` (+ its DLLs) in `C:\lucy\bin`. Use a CUDA/Vulkan
   build if you have a GPU.
2. Put a static **ffmpeg.exe** in `C:\lucy\bin` (and on PATH).
3. Download a model into `C:\lucy\models`: `ggml-large-v3-q5_0.bin` (CPU default; `ggml-medium.bin`
   if too slow; `ggml-large-v3.bin` on a GPU). **Avoid `*-turbo` for Chinese.**
4. Smoke-test:
   ```bat
   C:\lucy\bin\ffmpeg.exe -y -i C:\lucy\recordings\test.mkv -vn -ac 1 -ar 16000 C:\lucy\models\test.wav
   C:\lucy\bin\whisper-cli.exe -m C:\lucy\models\ggml-large-v3-q5_0.bin -l zh -osrt -of C:\lucy\models\test C:\lucy\models\test.wav
   REM -> C:\lucy\models\test.srt
   ```

### 4. Configure + run
1. Install **Node for Windows** (native, not WSL). Checkout this repo, `npm install`.
2. Copy `.env.agent.example` → `.env.agent` and set at least:
   ```
   WATCH_DIR=C:\lucy\transcripts
   CLOUD_URL=https://<app>.vercel.app
   AGENT_SECRET=<same long secret as Vercel>
   RECORDINGS_DIR=C:\lucy\recordings
   WHISPER_BIN=C:\lucy\bin\whisper-cli.exe
   WHISPER_MODEL=C:\lucy\models\ggml-large-v3-q5_0.bin
   WHISPER_LANG=zh
   FFMPEG_BIN=C:\lucy\bin\ffmpeg.exe
   ```
3. Keep **Anki** open with AnkiConnect (add-on `2055492159`) for card creation.
4. Run **both** processes (they are independent):
   ```bat
   npm run agent        REM ingests WATCH_DIR → cloud → cards
   npm run recorder     REM recordings → transcripts
   ```
5. Run on startup with pm2 (see the main README "Keeping the agent always-on"), adding a second entry
   for `npm run recorder`, or add both to the project's `ecosystem.config.cjs`.

### 5. End-to-end check
Press the OBS hotkey, speak a few Mandarin sentences, stop. Within a few minutes: a `.srt` appears in
`C:\lucy\transcripts`, the source `.mkv` moves to `C:\lucy\recordings\.done`, then a new Notion Lessons
row + queued `create_anki_cards` action + cards in `Chinese::Lessons`.

## Failure handling (by design)

- A recording that ffmpeg/whisper can't process, or that transcribes to nothing, is **moved to
  `RECORDINGS_DIR\.failed-audio`** — never deleted (it's the lesson's only copy) and never retried
  forever. Inspect it there.
- A transcript that already exists is **not re-transcribed** (idempotent); the cloud also dedups on
  content hash, so a re-run can't duplicate a lesson.
- Recordings that landed while the recorder was down are picked up by the **boot rescan** (recent
  window), same as the ingest daemon.

## Later enhancements (not in v1)

- **Speaker attribution** — record two OBS tracks (mic=student, desktop=tutor), transcribe each, label
  `Student:` / `Tutor:`, interleave. Big quality win for feedback/flashcards.
- **Automatic call detection** — audio-activated or Preply-tab detection to replace the hotkey.
