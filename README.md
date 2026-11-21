# Gray Swan Arena Chat Extractor

A Chrome (Manifest V3) extension that synchronizes live challenge state from **any** Gray Swan Arena challenge and exports your conversations to canonical JSON or ZIP.

## What's new in v2.3.0

- **🚀 Batch Mode 1-Click Opener:** On Batch Mode pages (`?batchGroupId=...`), a **🚀 Open all (N)** button is injected into each expanded attempt card header. One click opens all N model chats in a **dedicated new browser window** — no popup blocks, no manual clicking through 22 models.
- **Per-Challenge Persistent Storage (`gsa_entry::<slug>`):** Every challenge stores its own independent permanent cache bucket in `chrome.storage.local` (survives browser close, extension reload, and full PC reboots) with automatic migration from older versions.
- **Smart Incremental Sync (`⚡ Sync new`):** Keeps cached chats per challenge slug and stops paginating as soon as previously synced IDs are reached (`created_at DESC`), turning post-scenario updates on 1,500+ chat challenges from ~2 minutes into ~2–5 seconds.
- **Parallel Page Pool (`↻ Full`):** Fetches roster + page 0 simultaneously, then streams remaining pages concurrently through a shared semaphore (default `5x` parallel, configurable `1–10`).
- **Multi-Filter Server Sync (`⚡ Sync filtered`):** Checking 1+ scenarios and/or models reveals **⚡ Sync filtered**, fetching only those server-filtered slices in parallel.
- **Hierarchical Sorted ZIP Export (`<Scenario>/<Status>/<Model>`):** Toggle **Sorted** to package exports into structured folders: `<Scenario>/<Status>/<Model>/chat-*.json` (`Accepted`, `Rejected`, `Pending`, `Failed`) plus root `manifest.json`.
- **Live Website Sync:** Syncs challenge name, full scenario/model roster, appeals, and exact registered break counts directly from Gray Swan Arena.
- **Multi-Select Filters:** Dynamic `[Status ▾]`, `[Scenario ▾]`, and `[Model ▾]` multi-select checkbox menus.

## Install (unpacked)

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this folder (`gsa-ipi-extractor`).
3. Log in to Gray Swan Arena (`https://app.grayswan.ai`) in the same browser.

## Use

1. Open any challenge page on `*.grayswan.ai` (e.g., `/arena/challenge/lucky-break-payday` or `/arena/challenge/ipi-black-2026`).
2. The in-page floating widget (`🦢 Extractor`) and toolbar popup immediately sync the challenge name, registered website breaks (unique `scenario × model` breaks and solved scenarios), and roster filters.
3. Toggle **Sorted** (on by default) to automatically organize exports into `<Scenario>/<Status>/<Model>` folders.
4. Click **Extract all chats** to extract and automatically download the sorted ZIP (or use popup filters for targeted subsets).
5. Filter with multi-select **Status** (`All`, `Accepted`, `Pending`, `Rejected`, `Submission failed`), **Scenario**, and **Model** checkbox dropdowns, stat chips, or keyword search; inspect full dialogue, tool summaries, reasoning traces, and classification signals in the modal.
6. Click **Download Sorted ZIP** to save the structured archive.

## Output schema

Exported records follow canonical `formatVersion: 1` `arena-chat` JSON (`challenge`, `chatId`, `behaviorId`, `scenario`, `title`, `messages[]`, `model`, `submissionMeta`, `rejectionDetails`). See `AGENT_GUIDE.md` for the full schema reference and Python ingestion helper.

## Files

| Path | Purpose |
|---|---|
| `manifest.json` | MV3 manifest (`2.3.0`, matches `*.grayswan.ai`). |
| `background/service-worker.js` | Tab detection, live summary sync, per-slug extraction storage, badge management, batch window opener. |
| `lib/api-client.js` | SvelteKit `__data.json` devalue decoder, website break calculator, roster discovery, paginated extraction. |
| `lib/normalizer.js` | Dynamic model (`Td`), scenario, challenge, message, and telemetry normalization. |
| `lib/heuristics.js` | Submission/appeal verdict precedence and multi-turn refusal heuristics. |
| `lib/zip-writer.js` | Dependency-free STORE ZIP writer with filename deduplication. |
| `popup/*` | Popup UI: live break summary, roster-synced filters, inspector modal, JSON/ZIP download. |
| `content/content.js` | In-page floating widget with live SPA route syncing. |
| `content/batch-opener.js` | Batch Mode 1-click opener — injects 🚀 button into each attempt card. |
| `tests/test-suite.js` | Node verification suite (`node tests/test-suite.js`). |
