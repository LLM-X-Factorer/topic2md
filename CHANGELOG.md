# Changelog

All notable changes to this project will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This
project adheres to a pre-1.0 cadence: minor bumps are breaking/notable, patch
bumps are additive or fixes. Dates are in `YYYY-MM-DD`.

## [Unreleased]

Nothing yet.

## [0.2.0] — 2026-04-21

First tagged release post-MVP. The pipeline is end-to-end production-quality
on the default MiniMax M2.7 model, with real image attachment gated by CLIP +
alt-quality + vision-LLM rerank.

### Added

- **PDF export** via `scripts/mkpdf.mjs` (Chromium headless print-to-PDF) —
  weasyprint's CJK output was garbled on macOS Preview, Chromium's Type 3
  font embedding is cross-reader stable. Remote images are downloaded into
  `out/_pdf_assets/` first so the PDF is offline-reproducible.
- **CLIP warm-up** (#26) — `warmClipModel` fire-and-forget from
  `runTopic2md` / `regenSection` entry; cuts cold-start from ~114s to ~1.4s
  when the Replicate container is still warm from a prior run.
- **Persistent image embeddings** (#27) — `image_embeddings(url,
model_version, embedding BLOB)` table in SQLite caches jina-clip-v2
  embeddings across runs. 100% cache-hit on regen of prior runs; ~$0.17/run
  → near-zero for recurring URLs.
- **Alt-quality penalty** (#28) — soft multiplier on raw CLIP cosine for
  empty/generic alt, short alt, and CMS-dump upload-path URLs.
- **CLIP relevance gate** — `zsxkib/jina-clip-v2` on Replicate, threshold
  0.30 calibrated on 68 labeled candidates (AUC 0.85, recall 0.97,
  kills ~60% irrelevant). `REPLICATE_API_TOKEN` optional; absent ⇒ bypass.
- **Candidate pool + vision rerank** — all image plugins contribute
  candidates; qwen3-vl-32b picks one per section. `pickIndex = -1` is
  respected — no keyword fallback when vision deliberately rejects.
- **Background context field** (#24) — `WorkflowInput.background`
  (freeform) threads through research → outline → sections. Persisted in
  `runs.background`. CLI `--background` / `--background-file`; Web UI via
  collapsible textarea. `regen` reuses the source run's background unless
  overridden.
- **SQLite persistence** — `runs` + `run_stages` tables record every
  `runTopic2md` invocation; `topic2md list / show / regen --section N`.
- **LLM model fallback chain** with per-generation Langfuse telemetry
  (`generation.*` events).
- **Plugin `dispose?()`** lifecycle hook — runner calls in `finally` to
  release Playwright browsers and DB handles.

### Changed

- `generateObject` forced to `mode: 'json'` to avoid the malformed
  tool-call JSON path on OpenRouter-routed providers (MiniMax/GLM). Cut
  sections step from ~500s → ~60s.
- Open-source hygiene overhaul: `CONTRIBUTING.md`, `SECURITY.md`, GitHub
  issue / PR templates, full English `README.en.md`.

### Fixed

- Outline retries once on first-attempt failure before giving up.
- Section two-retry failure now renders outline bullets as a bullet-list
  fallback rather than leaving the section empty.
- `regen` runId parsing accepts nanoids that start with `-` / `_`
  (previously filtered by `!arg.startsWith('-')`).
- Docker image copies the full workspace + installs `build-essential` so
  `better-sqlite3` can build from source on unusual glibc/node combos.
- `DATABASE_URL` anchored via `import.meta.url` so Web UI and CLI share one
  run history regardless of cwd.

## [0.1.0] — ~2026-03

Initial MVP. Mastra workflow skeleton, Tavily source, file publish,
Playwright screenshot, Next.js trigger UI. Single model, no persistence, no
regeneration. Historical record only; not tagged.
