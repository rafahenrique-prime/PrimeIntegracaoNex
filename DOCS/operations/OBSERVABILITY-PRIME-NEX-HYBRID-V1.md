# PRIME NEX Observability V1 — Hybrid Route and NEX Position

## Objective and baseline

This document defines additive JSONL telemetry for the Hybrid V3 export
path. It addresses the historical gap where the route had to be inferred
from source code and the operational NEX state.

- Baseline before this change: `6255ee59fd6f52435c11fb4e7da3dcee2ad69479`.
- Scope: observability only. It does not change Task scheduling, NEX input,
  V1/V2 routing, G13, retry, save dialog, watcher behavior, publication, or
  the effective production watcher timeout of 30 seconds.

## Hybrid decision architecture

`HybridInputSender` reads the foreground HWND and its owning PID exactly once.
If the HWND is the validated NEX main window, or its PID is the validated NEX
PID, it delegates to V1. Otherwise it delegates to V2. The decision is stored
before delegation, so a delegated sender failure is still logged with the
known route context. In a normal Hybrid flow, `ExportTriggered` is the first
stage that carries this route context.

Pre-orchestrator classification is performed by `INexRuntimeStateProbe`:

| Runtime state | hybridRoute | nexPosition | routeReason | Behavior |
|---|---|---|---|---|
| Open, NEX foreground | V1 | FOREGROUND | FOREGROUND_HWND_OR_PID_MATCHED_NEX | normal Hybrid route |
| Open, NEX background | V2 | BACKGROUND | FOREGROUND_NOT_OWNED_BY_NEX | normal Hybrid route |
| Minimized | NONE | MINIMIZED | NEX_MINIMIZED | no export |
| Closed | NONE | CLOSED | NEX_CLOSED | no export |
| BlockingUnknown | NONE | UNKNOWN | NEX_BLOCKING_UNKNOWN | fail-closed, no export |

`routeReason` is deterministic telemetry. It never replaces the existing
`reason`, which remains the detailed technical diagnostic from the component
that produced it.

## JSONL schema

### Before

```json
{"timestamp":"...","runId":"...","stage":"Success","errorCode":null,"fileName":"...","reason":null}
```

### After

```json
{"timestamp":"...","runId":"...","stage":"Success","errorCode":null,"fileName":"...","reason":null,"hybridRoute":"V2","nexPosition":"BACKGROUND","routeReason":"FOREGROUND_NOT_OWNED_BY_NEX"}
```

The three fields are optional and may be `null` for non-Hybrid modes or for
events emitted before a Hybrid decision. Existing field names and casing are
unchanged. Consumers must ignore unknown JSON properties; the Monitor V1 uses
`ConvertFrom-Json` and reads only its existing fields, so no Monitor change is
expected.

## Compatibility, invariants, and rollback

- Older JSONLs do not have the new fields and remain valid; historical route
  analysis still requires inference where those fields are absent.
- V1 and V2 input implementations are not changed. The optional context is
  implemented only by `HybridInputSender`.
- Fail-closed behavior, zero retry, G13, save dialog validation, reader,
  publisher, and the production 30-second watcher timeout are preserved.
- `PollingExportStageWatcher.DefaultTimeout` remains 15 seconds for existing
  diagnostic-probe callers and is outside this observability change.
- Rollback is the dedicated Git commit that introduces this additive schema.
  Logs already written remain parseable because the fields are additive.

## Tests and acceptance

Automated tests cover V1/V2 route selection, one selected sender and zero
fallback, context preservation after a sender exception, pre-orchestrator
Closed/Minimized/BlockingUnknown logs, and JSON serialization of old plus new
fields. No long real-time waits are introduced.

Homologation requires a build and tests, one natural foreground cycle and one
natural background cycle, JSONL evidence of explicit route and position, and
confirmation that Monitor V1 remains read-only and functional.

## Quick diagnostic guide

1. Locate all JSONL records for a `runId`.
2. Read `hybridRoute`, `nexPosition`, and `routeReason` when present.
3. Use `reason` for the underlying gate or failure detail.
4. If the three fields are absent, identify the log as pre-Observability V1
   or non-Hybrid and use source/runtime evidence rather than asserting route.

## Known limitations

JSONLs written before Observability V1 have no explicit route or NEX position.
`routeReason` states only why the route or pre-orchestrator outcome was chosen;
it is not a replacement for the detailed failure `reason`.
