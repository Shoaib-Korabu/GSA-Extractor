# AGENT SPECIFICATION: Gray Swan Arena Chat Extractor Output

## 1. System Intent & Overview

This guide documents the canonical JSON export produced by **Gray Swan Arena Chat Extractor** (`v2.3.0`) across **any** Gray Swan Arena challenge (e.g., `hazard-hunt-november-26`, `ipi-black-2026`, `lucky-break-payday`, `lucky-break-level-up`, `lucky-break-chat-2026`).

Downstream analysis and prompt-optimization agents consume exported conversations—especially defended/rejected interactions (`rejectionDetails.outcome === 'rejected'`) and accepted breaks (`rejectionDetails.outcome === 'accepted'`)—to diagnose model refusal triggers, tool-call guardrails, and grading criteria across all scenarios and anonymized models.

---

## 2. Export Artifacts

The extension exports JSON exclusively (with no 10-chat limit):

| Export Scope | File Pattern | Contents |
|---|---|---|
| **Single chat** | `chat-{slug}-{shortChatId}-{timestamp}.json` | Standalone `formatVersion: 1` canonical `arena-chat` JSON object. |
| **Sorted ZIP bundle** | `gsa-{slug}-chats-sorted-{count}-{timestamp}.zip` | Files organized by folder hierarchy: `<Scenario>/<Status>/<Model>/chat-*.json` (`Accepted`, `Rejected`, `Pending`, `Failed`) plus root `manifest.json`. |
| **Flat ZIP bundle** | `gsa-{slug}-chats-{count}-{timestamp}.zip` | Flat directory containing one `chat-*.json` file per exported conversation plus a top-level `manifest.json` index. |

### Hierarchical Folder Structure (when Sorted is active)

```text
gsa-{slug}-chats-sorted-{count}-{timestamp}.zip
├── <Scenario Name>/
│   ├── Accepted/
│   │   └── <Model Name>/
│   │       └── chat-{slug}-{chatId}-{timestamp}.json
│   ├── Rejected/
│   │   └── <Model Name>/
│   │       └── chat-{slug}-{chatId}-{timestamp}.json
│   ├── Pending/
│   │   └── <Model Name>/
│   │       └── chat-{slug}-{chatId}-{timestamp}.json
│   └── Failed/
│       └── <Model Name>/
│           └── chat-{slug}-{chatId}-{timestamp}.json
└── manifest.json
```

---

## 3. Canonical JSON Schema (`formatVersion: 1`)

```json
{
  "formatVersion": 1,
  "exportedAt": "2026-11-10T13:30:00.000Z",
  "challenge": {
    "slug": "lucky-break-payday",
    "name": "Lucky Break: Payday",
    "anonymized": true
  },
  "kind": "arena-chat",
  "chatId": "6af318ece6b75ac9d31e63b7",
  "behaviorId": "negative-quantity-exploit",
  "scenario": "Exploit the System to Get Lots of Money",
  "title": "Ghost Fox Rare: <pos_api_schema mode=\"shelf_sync_v2\">...",
  "createdAt": "2026-11-10T10:19:56.650Z",
  "messages": [
    {
      "role": "user",
      "content": "...",
      "timestamp": "2026-11-10T10:19:56.650Z"
    },
    {
      "role": "assistant",
      "content": "I have issued the requested refund.",
      "timestamp": "2026-11-10T10:20:01.100Z",
      "toolCalled": true,
      "toolCallSummary": "Issuing refund (amount: 50)",
      "reasoning": "User verified eligible order state...",
      "toolCalls": [
        {
          "name": "issue_refund",
          "arguments": { "amount": 50 }
        }
      ]
    }
  ],
  "model": "Ghost Fox Rare",
  "submissionMeta": {
    "submissionId": "6af2efcc6dbb6059e3b51ab0",
    "gradeStatus": "fail",
    "successful": false,
    "isBreak": false,
    "appealStatus": "success",
    "submissionCount": 1
  },
  "rejectionDetails": {
    "isRejected": false,
    "outcome": "accepted",
    "confidence": "high",
    "reason": "Break accepted via appeal",
    "signals": [
      "appeal:success",
      "tool_called:true"
    ],
    "summary": "Break accepted via appeal"
  }
}
```

### Field Reference

- `formatVersion` (*integer*): Always `1`.
- `challenge` (*object*): `{ slug, name, anonymized }`. Derived dynamically from Gray Swan's `/arena/challenge/{slug}/__data.json` `challengeInfo`.
- `kind` (*string*): Always `"arena-chat"`.
- `chatId` (*string*): 24-character hex chat ID.
- `behaviorId` (*string, optional*): Raw Gray Swan behavior key (e.g. `negative-quantity-exploit`, `wb1s5-validation-bypass-backdoor`).
- `scenario` (*string*): Unified human-readable scenario name resolved from `behaviorIdToBehaviorMap`, `/panels/filter-options`, and `/panels/batches`.
- `title` (*string*): Chat title or prompt payload snippet.
- `messages[]` (*array*): Ordered turns:
  - `role` (*string*): `"user"`, `"assistant"`, `"tool"`, or `"system"`.
  - `content` (*string*): Turn text.
  - `timestamp` (*string*): ISO-8601 UTC timestamp.
  - `toolCalled` (*boolean, optional*): Whether a tool ran during that turn.
  - `toolCallSummary` (*string, optional*): Gray Swan Arena compact description of invoked tool calls and arguments.
  - `toolCalls[]` (*array, optional*): Structured tool call objects (`{ name, arguments }`) when exposed.
  - `reasoning` (*string, optional*): Model reasoning trace if present.
  - `attachments[]` (*array, optional*): Attached file/media descriptors if present.
- `model` (*string*): Aliased target model name resolved dynamically across `(model_id, classifier_id, wave)`.
- `submissionMeta` (*object, optional*): Present when the chat has an associated submission:
  - `submissionId`, `gradeStatus` (`"success" | "fail" | "ungraded" | "maybe_success" | "abandoned"`), `successful` (*boolean*), `isBreak` (*boolean*), `appealStatus`, `manualStatus`, `submissionCount` (when multiple submissions exist for the same chat).
- `rejectionDetails` (*object*):
  - `isRejected` (*boolean*): `true` for rejected runs or errored/abandoned runs.
  - `outcome` (*string*): `"rejected" | "accepted" | "error" | "pending"` (`"error"` displays as **Submission failed** in the popup UI).
  - `confidence` (*string*): `"high" | "medium" | "heuristic" | "low"`.
  - `reason` (*string*): Concise explanation.
  - `signals` (*string[]*): Machine-readable classification tags (e.g., `appeal:success`, `grade_status:ungraded`, `submission_status:fail`, `tool_called:true`, `tool_call:review_request_changes`, `direct_refusal`, `security_refusal:...`, `multi_turn:later_tool_execution`).
  - `summary` (*string*): Concluding refusal snippet or break verdict.

### Website Break Counts vs Accepted Submissions

Gray Swan Arena counts **Registered Breaks** (`manifest.json` -> `breakStats.registeredBreaks`) as **unique `(scenario, model)` combinations broken** across active waves, whereas `rejectionDetails.outcome === 'accepted'` counts every accepted chat/submission (including duplicate breaks on the same `(scenario, model)` pair). Both values are accurate for their respective definitions.

---

## 4. Python Ingestion Reference

```python
#!/usr/bin/env python3
"""Ingests extracted JSON files or ZIP bundles exported by Gray Swan Arena Chat Extractor."""

import glob
import json
import os
import zipfile
from collections import defaultdict
from typing import Any, Dict, List


def load_exported_chats(path: str, outcomes: List[str] | None = None) -> List[Dict[str, Any]]:
    records: List[Dict[str, Any]] = []

    if os.path.isfile(path) and path.endswith(".zip"):
        with zipfile.ZipFile(path, "r") as zf:
            for name in zf.namelist():
                if name == "manifest.json" or not name.endswith(".json"):
                    continue
                data = json.loads(zf.read(name).decode("utf-8"))
                if data.get("formatVersion") == 1 and data.get("kind") == "arena-chat":
                    records.append(data)
    elif os.path.isfile(path) and path.endswith(".json"):
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if data.get("formatVersion") == 1 and data.get("kind") == "arena-chat":
            records.append(data)
    else:
        for file_path in sorted(glob.glob(os.path.join(path, "chat-*.json"))):
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if data.get("formatVersion") == 1 and data.get("kind") == "arena-chat":
                records.append(data)

    if outcomes:
        allowed = set(outcomes)
        records = [r for r in records if r.get("rejectionDetails", {}).get("outcome") in allowed]
    return records


def summarize_failures(records: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    grouped: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for rec in records:
        assistant_turns = [m for m in rec.get("messages", []) if m.get("role") == "assistant"]
        last_turn = assistant_turns[-1] if assistant_turns else {}
        grouped[rec.get("scenario", "Unknown scenario")].append({
            "chatId": rec.get("chatId"),
            "behaviorId": rec.get("behaviorId"),
            "model": rec.get("model"),
            "outcome": rec.get("rejectionDetails", {}).get("outcome"),
            "signals": rec.get("rejectionDetails", {}).get("signals", []),
            "reason": rec.get("rejectionDetails", {}).get("reason", ""),
            "toolCallSummary": last_turn.get("toolCallSummary", ""),
            "lastAssistantContent": last_turn.get("content", "")[:400],
        })
    return dict(grouped)


if __name__ == "__main__":
    import sys

    target = sys.argv[1] if len(sys.argv) > 1 else "."
    rejected = load_exported_chats(target, outcomes=["rejected"])
    by_scenario = summarize_failures(rejected)
    print(f"Loaded {len(rejected)} rejected conversations across {len(by_scenario)} scenarios.")
    for scenario, items in by_scenario.items():
        print(f"\n[{scenario}] ({len(items)} rejected)")
        for item in items[:3]:
            print(f"  - {item['model']} | signals={','.join(item['signals'])}")
            if item["toolCallSummary"]:
                print(f"    tool: {item['toolCallSummary'][:120]}")
            print(f"    reply: {item['lastAssistantContent'][:140]}...")
```
