---
name: memory
description: "Runs cross-store memory retrieval and index maintenance workflows with bounded filters and timeline anchors. Use when querying historical context or repairing memory index health."
---

# memory

Use this skill when the user asks for historical context lookup, timeline reconstruction,
or memory index diagnostics.

## Contents

- [Core contract](#core-contract)
- [Preflight checks](#preflight-checks)
- [Query workflows](#query-workflows)
- [Index maintenance workflows](#index-maintenance-workflows)
- [Diagnostics and recovery](#diagnostics-and-recovery)
- [Evaluation scenarios](#evaluation-scenarios)

## Core contract

1. **Bounded queries first**
   - Start with narrow filters and explicit `--limit`.
   - Expand scope only when needed.

2. **Use the memory CLI surface**
   - Use `mu memory search|timeline|stats|index ...`.
   - Do not manually inspect/parse store files first unless memory commands fail.

3. **Read -> refine -> verify**
   - Run an initial query, inspect quality, refine filters, then confirm result relevance.

4. **Index-aware behavior**
   - `search/timeline/stats` auto-heal missing indexes when possible.
   - Use explicit index status/rebuild commands for deterministic maintenance.

## Preflight checks

```bash
mu status --pretty
mu memory --help
mu memory index status --pretty
```

Optional source inventory:

```bash
mu memory stats --pretty
```

## Query workflows

### 1) Search for relevant context

```bash
mu memory search --query "<topic>" --limit 20
```

Refine with anchors/filters as needed:

```bash
mu memory search \
  --query "<topic>" \
  --issue-id <issue-id> \
  --run-id <run-id> \
  --source events \
  --limit 30 --pretty
```

### 2) Reconstruct timeline around an anchor

Timeline requires at least one anchor (for example `--issue-id`, `--run-id`,
`--session-id`, `--conversation-key`, `--topic`, or `--channel`):

```bash
mu memory timeline --issue-id <issue-id> --order desc --limit 40 --pretty
```

### 3) Gather source-level memory stats

```bash
mu memory stats --pretty
mu memory stats --source events --json --pretty
```

Useful for identifying dominant sources, recency gaps, and text-volume skew.

## Index maintenance workflows

### 1) Inspect index health

```bash
mu memory index status --pretty
```

### 2) Rebuild full index

```bash
mu memory index rebuild --pretty
```

### 3) Rebuild selected sources

```bash
mu memory index rebuild --sources issues,forum,events --pretty
```

Use targeted rebuilds when one source is stale/corrupted.

## Diagnostics and recovery

If memory results are missing or low quality:

1. Verify index and rebuild if needed:

```bash
mu memory index status --pretty
mu memory index rebuild --pretty
```

2. Re-run query with explicit anchors:

```bash
mu memory search --query "<topic>" --issue-id <issue-id> --limit 30 --pretty
mu memory timeline --run-id <run-id> --order desc --limit 50 --pretty
```

3. Validate source coverage:

```bash
mu memory stats --pretty
```

4. Apply smallest correction:
- tighten/expand filters
- adjust anchors (`issue_id`, `run_id`, `session_id`, `topic`, channel metadata)
- rebuild selected sources only

Compatibility note:
- `mu context ...` remains an alias to `mu memory ...`.

## Evaluation scenarios

1. **Issue-scoped context retrieval**
   - Setup: user asks for prior decisions on one issue.
   - Expected: `search` + `timeline` with `--issue-id` produce coherent, bounded context summary.

2. **Missing-index auto-heal and explicit rebuild**
   - Setup: index file missing/stale.
   - Expected: query path auto-heals missing index when possible; explicit `index rebuild` restores healthy status deterministically.

3. **Channel/session forensic lookup**
   - Setup: user asks what happened in a specific conversation/session.
   - Expected: anchored filters (`--session-id`/`--conversation-key`/`--channel`) recover relevant chronology without unrelated noise.
