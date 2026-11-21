# Chrome Web Store Listing — Gray Swan Arena Chat Extractor

> Last Updated: 2026-11-18

## Store Listing

**Extension Name** [REQUIRED]
Gray Swan Arena Chat Extractor

**Short Description** [REQUIRED]
Sync challenges, inspect conversation outcomes and registered breaks, and export Gray Swan Arena chats to JSON or ZIP.

**Detailed Description** [REQUIRED]
Gray Swan Arena Chat Extractor helps AI security researchers and red-teamers synchronize, inspect, and export their conversation records across any Gray Swan Arena challenge directly from the active browser session.

Features:
- Fast incremental & parallel sync: pulls only new chats and updated verdicts into local cache in seconds (`Sync new`), supports one-click single-scenario server sync (`?behavior=<slug>`), and accelerates full syncs via a shared concurrent page pool (`Full`).
- Universal auto-detection across all Gray Swan Arena challenges, automatically loading challenge names, scenarios, models, and live registered break counts from your active session.
- Hierarchical **Sorted** export toggle in both the in-page floating widget and toolbar popup: automatically organizes ZIP exports into clean `<Scenario>/<Status>/<Model>` directories (`Accepted`, `Rejected`, `Pending`, `Failed`).
- Multi-select **Status** (`All`, `Accepted`, `Pending`, `Rejected`, `Submission failed`), **Scenario**, and **Model** checkbox filter dropdowns synchronized with the live challenge roster so batch and single-turn chats group cleanly.
- Outcome classification across rejected attempts, accepted breaks (including appeals), pending autogrades, and submission errors.
- Per-challenge storage isolation so navigating between challenges keeps metrics and cached logs strictly scoped to the active challenge.
- Built-in conversation inspector displaying multi-turn messages, tool call summaries, reasoning traces, and classification signals.
- Unlimited pagination export (configure max pages or set `0` for unlimited): export a single conversation as `.json` or multi-chat selections as a `.zip` archive with a `manifest.json` index.

How to use:
1. Log in to Gray Swan Arena (`https://app.grayswan.ai`) and open any challenge page.
2. Click the toolbar icon or use the floating bottom-right widget to view live website break stats.
3. Click **Extract chats** to collect your conversations and submissions.
4. Filter by outcome, scenario, model, or keyword, then click **Download JSON**.

Privacy & Security:
This extension operates entirely locally in your browser. All requests run directly between your browser and Gray Swan Arena (`*.grayswan.ai`) using your existing session cookies. Conversation logs are stored locally via Chrome storage APIs and are never sent to external third-party servers.

**Category** [REQUIRED]
Developer Tools

**Single Purpose** [REQUIRED]
Synchronize challenge metadata and export user-owned conversation logs from Gray Swan Arena challenges to local JSON or ZIP files.

**Primary Language** [REQUIRED]
English

## Permissions Justification

| Permission | Type | Justification |
|---|---|---|
| `storage` | permissions | Stores extracted chats and challenge summaries scoped by challenge slug locally in the browser for quick reopening. |
| `unlimitedStorage` | permissions | Allows storing large multi-challenge chat archives locally without hitting the standard Chrome local storage cap. |
| `downloads` | permissions | Reserved for download workflow integration alongside user-initiated `.json` and `.zip` file exports. |
| `tabs` | permissions | Reads the active tab URL and title on `*.grayswan.ai` to auto-detect the current challenge slug. |
| `https://app.grayswan.ai/*` | host_permissions | Communicates with Gray Swan Arena endpoints using the active authenticated session. |
| `https://*.grayswan.ai/*` | host_permissions | Supports subdomains and challenge hosts under `grayswan.ai`. |

## Privacy & Data Use

**Does the extension collect user data?** No

- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Version History

| Version | Date | Changes | Status |
|---|---|---|---|
| 2.3.0 | 2026-11-21 | **Batch Mode 1-Click Opener**: 🚀 button injected into each expanded batch attempt card header — opens all N model chats in a dedicated new browser window (bypasses popup blocker via `chrome.windows.create`). Added `windows` permission. Multi-strategy DOM detection with `MutationObserver` for SPA navigation. | Active |
| 2.2.1 | 2026-11-18 | Isolated permanent per-challenge storage buckets (`gsa_entry::<slug>` with auto-migration), `<Scenario>/<Status>/<Model>` Sorted ZIP hierarchy (`Accepted`/`Rejected`/`Pending`/`Failed`), multi-filter server sync (`?behavior=` + `?model=`), and live two-way `Sorted` toggle sync across popup and open tabs. | Superseded |
| 2.2.0 | 2026-11-18 | Added smart incremental sync (`Sync new`), shared-semaphore parallel page pool (`5x` default concurrency + 429/5xx backoff), server-side single-scenario sync (`?behavior=<slug>`), free `__data.json` appeal updates onto cached chats, and real page-based progress bars. | Superseded |
| 2.1.0 | 2026-11-10 | Added live `__data.json` website break & roster sync, multi-select Status/Scenario/Model filters, hierarchical Sorted ZIP export, per-slug storage isolation, `Td` model resolution, and `toolCallSummary` + `reasoning` preservation. | Superseded |
| 2.0.0 | — | Universal rewrite with runtime roster detection and JSON/ZIP export. | Superseded |
| 1.0.0 | 2026-10-17 | Initial IPi-Black release. | Superseded |
