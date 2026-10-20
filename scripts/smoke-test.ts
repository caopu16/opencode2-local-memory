#!/usr/bin/env node
// Smoke test: load the v2 plugin against a fake ctx, let setup() register a
// memory_search tool / a session 'context' inject hook / a session.idle event
// subscription, then drive each path:
//   - push a session.idle event through the fake event stream -> capture
//   - call the registered context hook -> inject into a mutable system[]
//   - call the registered memory_search tool -> search a real memory dir

import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin from '../src/index.ts'

const failures: string[] = []
const check = (label: string, ok: boolean) => {
  console.log((ok ? 'ok   ' : 'FAIL ') + label)
  if (!ok) failures.push(label)
}

const projectDir = mkdtempSync(join(tmpdir(), 'opencode2-local-memory-smoke-'))
process.env.MEMSEARCH_DIR = join(projectDir, '.memsearch')

// ---- a fake v2 session context (ctx.session.context output) ----
// v2 messages are self-contained: user has .text, assistant has .content[].
const turnMessages = [
  { id: 'msg_1', type: 'user', time: { created: 1 }, text: 'please remember the smoke prompt about flyway V22' },
  {
    id: 'a_1', type: 'assistant', time: { created: 2 },
    model: { providerID: 'openai', id: 'gpt-x' },
    content: [
      { type: 'text', text: 'smoke reply, fixed the migration' },
      { type: 'tool', tool: 'read', state: { status: 'completed' } },
    ],
  },
]

// ---- build a fake ctx that records registrations ----
let toolDef: any = null
let contextHook: ((req: any) => any) | null = null
const eventQueue: any[] = []
let eventResolve: ((v: any) => void) | null = null
let generateCalls = 0

// an async-iterable event stream the plugin subscribes to
async function* eventStream() {
  while (true) {
    if (eventQueue.length > 0) { yield eventQueue.shift(); continue }
    await new Promise<void>((r) => { eventResolve = () => r() })
  }
}
const pushEvent = (e: any) => { eventQueue.push(e); if (eventResolve) { const r = eventResolve; eventResolve = null; r(e) } }

const ctx: any = {
  location: { directory: projectDir, project: { id: 'proj' } },
  options: { minPromptLength: 4 },
  session: {
    context: async ({ sessionID }: any) => (sessionID === 'ses_main' ? turnMessages : []),
    hook: async (name: string, cb: any) => {
      if (name === 'context') contextHook = cb
      return { dispose: async () => {} }
    },
  },
  tool: {
    transform: async (cb: any) => {
      cb({ add: (def: any) => { toolDef = def } })
      return { dispose: async () => {} }
    },
  },
  event: {
    subscribe: () => eventStream(),
  },
  generate: {
    text: async ({ prompt, model }: any) => {
      generateCalls += 1
      check('summarizer gets a model route', Boolean(model?.providerID && model?.id))
      check('summarizer prompt carries the transcript', String(prompt).includes('flyway V22'))
      return { text: '- User asked to remember the flyway V22 smoke prompt.\n- Assistant fixed the migration.' }
    },
  },
}

const cleanup = await plugin.setup(ctx)

check('registers memory_search tool', Boolean(toolDef && toolDef.name === 'memory_search'))
check('registers session context inject hook', typeof contextHook === 'function')

// ---- drive capture via a session.idle event ----
pushEvent({ type: 'session.idle', data: { sessionID: 'ses_main' } })
// allow the subscription loop + serialized capture chain to settle
await new Promise((r) => setTimeout(r, 100))

const memoryDir = join(projectDir, '.memsearch', 'memory')
let dailyFiles: string[] = []
try { dailyFiles = readdirSync(memoryDir).filter((f) => /\d{4}-\d{2}-\d{2}\.md/.test(f)) } catch { /* none */ }
check('capture wrote a daily file', dailyFiles.length === 1)
const dailyText = dailyFiles.length ? readFileSync(join(memoryDir, dailyFiles[0]), 'utf-8') : ''
check('daily file has the session/turn anchor', dailyText.includes('<!-- session:ses_main turn:msg_1 db:session:ses_main -->'))
check('daily file has the summary body', dailyText.includes('flyway V22 smoke prompt'))
check('summarizer was invoked once', generateCalls === 1)

// a repeated idle for the same captured turn must NOT write a duplicate
pushEvent({ type: 'session.idle', data: { sessionID: 'ses_main' } })
await new Promise((r) => setTimeout(r, 60))
const filesAfter = readdirSync(memoryDir).filter((f) => /\d{4}-\d{2}-\d{2}\.md/.test(f))
const anchorCount = readFileSync(join(memoryDir, filesAfter[0]), 'utf-8').split('turn:msg_1').length - 1
check('duplicate idle does not re-capture the same turn', anchorCount === 1)

// ---- inject ----
const request: any = { system: [{ type: 'text', text: 'You are a helpful agent.' }] }
contextHook!(request)
check('inject folds memory into system[0]', request.system[0].text.includes('opencode2-local-memory'))
check('inject keeps a single system entry', request.system.length === 1)
// idempotent: a second call replaces in place, does not stack
contextHook!(request)
const markerCount = request.system[0].text.split('opencode2-local-memory').length - 1
check('inject is idempotent (marker appears once)', markerCount === 1)

// ---- memory_search ----
const searchOut = await toolDef.execute({ query: 'flyway', top_k: 3 }, { directory: projectDir })
const searchText = typeof searchOut === 'string' ? searchOut : searchOut?.content
check('memory_search returns text with a match', typeof searchText === 'string' && searchText.includes('flyway'))
console.log('\n--- memory_search output ---')
console.log(String(searchText).slice(0, 500))

// ---- cleanup ----
if (typeof cleanup === 'function') cleanup()
rmSync(projectDir, { recursive: true, force: true })

console.log()
if (failures.length > 0) {
  console.error('FAIL: ' + failures.length + ' check(s) failed: ' + failures.join('; '))
  process.exit(1)
}
console.log('PASS: smoke test completed')
process.exit(0)