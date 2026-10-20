# Design

## Goals

- Provide cross-session memory for opencode v2 without native/vector dependencies.
- Keep storage compatible with the @zilliz/memsearch-opencode plugin so both
  read and append to the same daily markdown files.
- Let the model proactively recall older memory with a lightweight tool.

## Non-goals

- Semantic / vector search. The machine cannot run numpy-based embeddings, and
  the memsearch Milvus path was never functional here.
- Editing opencode core. Everything lives in this standalone plugin and the
  user-level opencode config entry.
- A background capture daemon. The official plugin polls opencode's SQLite with
  a Python daemon; this plugin instead captures in-process on `session.idle`
  (subscribed through `ctx.event.subscribe()`).

## Data flow

```
ctx.event.subscribe() -> session.idle (real session)
  └─ capture.ts: ctx.session.context() -> renderLastTurn
       -> summarizeTurn (ctx.generate.text) -> writeCapture
       -> <project>/.memsearch/memory/YYYY-MM-DD.md

ctx.session.hook('context')
  └─ inject.ts: recentMemories (last N daily files) -> buildMemoryBlock
       -> mergeSystemMemory (fold into request.system[0], index.ts)

ctx.tool.transform() -> memory_search tool
  └─ search.ts: read all daily files -> split by ### headings
       -> substring scoring -> top_k formatted text
```

## Capturing a finished turn

opencode has no committed-event projection (the DSH 0.2.x mechanism). Instead,
when a session goes idle the plugin reads `ctx.session.context()` and renders the
last turn: the final real user message plus every assistant message and tool part
that follows it. v2 messages are self-contained (user `.text`, assistant
`.content[]`). Tool calls are compressed to a counted `[Tools]` line; tool
arguments and results are dropped (noisy, recoverable from the session itself).

Idempotency is anchor-based: before writing, capture scans the daily files for
`<!-- session:ID turn:TURN `. The turn id is the originating user message id.

### No recursion risk

Summarization is a single stateless `ctx.generate.text()` call. It creates no new
session and emits no `session.idle`, so memory cannot feed on itself. (The v1
design spun up a scratch session and needed a scratch-id Set to guard against
self-capture; v2 drops that machinery entirely.)

## Injection

The session `context` hook (`ctx.session.hook('context', cb)`) receives the
request with a mutable `system: SystemPart[]`. The memory block is folded into
`system[0]` rather than pushed as a new entry, because some backends reject
multi-entry system arrays. A MARKER delimits the block so repeated hook calls
replace in place instead of stacking.

## Summarization route

`provider`/`model` config wins; otherwise the turn's own assistant provider and
model are reused (read off the last assistant message). If neither is available
the plugin writes a "summary unavailable" note plus a truncated raw transcript —
memory is never dropped because summarization failed.

## Search scoring

`memory_search` is deliberately simple:

1. Lowercase the query and the haystack.
2. Split the query on whitespace into terms; a Chinese phrase without spaces is
   one term.
3. For each `###` block, score = sum of substring hits per term + 2 × number of
   full-query substring hits.
4. Return the top `top_k` blocks sorted by score.

Predictable, dependency-free, and sufficient for environment-fact recall.

## Plugin shape

The default export is an opencode v2 plugin definition:
`Plugin.define({ id, setup(ctx) })` from `@opencode/plugin`. `setup` registers
everything through the context: `ctx.tool.transform()` adds `memory_search`,
`ctx.session.hook('context')` injects memory, and `ctx.event.subscribe()` drives
capture on `session.idle`. `setup` returns a cleanup function that disposes the
registrations and aborts the event subscription. The `memory_search` tool input
is a plain JSON Schema object (no zod dependency).
