/**
 * opencode2-local-memory — opencode v2 local cross-session memory plugin.
 *
 * Ported to the opencode v2 plugin contract (@opencode/plugin): a default
 * export of Plugin.define({ id, setup(ctx) }). setup registers everything
 * through the context instead of returning a V1 Hooks object:
 *   - capture:  ctx.event.subscribe() watches session.idle, reads the finished
 *               turn with ctx.session.context(), summarizes it via ctx.generate,
 *               and appends to today's daily file.
 *   - inject:   ctx.session.hook('context') folds the recent daily files into
 *               the request's mutable system[] array (idempotent, replace-in-place).
 *   - search:   ctx.tool.transform() adds a memory_search tool that scans ALL
 *               daily files with pure-JS keyword scoring.
 *
 * The zero-native-dependency design and on-disk format are unchanged, so it still
 * shares <project>/.memsearch/memory/YYYY-MM-DD.md with @zilliz/memsearch-opencode.
 *
 * Install: add to opencode.jsonc "plugins": ["opencode2-local-memory"] (npm) or a
 * local path. See README.md.
 */

import { Plugin } from '@opencode/plugin'
import { DEFAULTS, MARKER, PLUGIN_NAME, type Options } from './constants.ts'
import { memoryDirFor } from './util.ts'
import {
  captureExists,
  renderLastTurn,
  summarizeTurn,
  writeCapture,
  type RenderedTurn,
} from './capture.ts'
import { recentMemories, buildMemoryBlock } from './inject.ts'
import { searchMemories, formatSearchResults } from './search.ts'

function resolveOptions(options?: Record<string, unknown>): Options {
  return { ...DEFAULTS, ...(options ?? {}) } as Options
}

export default Plugin.define({
  id: PLUGIN_NAME,
  async setup(ctx) {
    const opts = resolveOptions(ctx.options as Record<string, unknown>)
    const projectDir = ctx.location.directory || process.cwd()
    const cleanups: Array<() => void> = []

    // Scratch sessions created for summarization: their own session.idle events
    // must never trigger capture, or memory would feed on itself recursively.
    const scratchSessions = new Set<string>()

    // Serialize capture: summarization is expensive and concurrent appends would
    // scramble daily-file ordering.
    let chain: Promise<void> = Promise.resolve()
    const enqueue = (work: () => Promise<void>) => {
      chain = chain.then(work).catch((error) => {
        console.warn('[local-memory] capture failed: ' + (error as Error).message)
      })
    }

    const processIdleSession = async (sessionID: string) => {
      const directory = projectDir
      const memoryDir = memoryDirFor(directory)

      let messages
      try {
        messages = await ctx.session.context({ sessionID })
      } catch {
        return
      }
      if (!Array.isArray(messages)) return

      const rendered: RenderedTurn | null = renderLastTurn(messages, opts.captureMaxChars)
      if (!rendered) return
      if (rendered.userText.length < opts.minPromptLength) return
      if (captureExists(memoryDir, sessionID, rendered.turnId)) return

      let body = rendered.render
      if (opts.summarizeEnabled) {
        try {
          const summary = await summarizeTurn(ctx, opts, rendered)
          if (summary) {
            body = summary
          } else {
            body = '- Memory summary unavailable: summarizer returned empty output.'
          }
        } catch (error) {
          // Never lose memory because summarization failed: fall back to the raw
          // transcript (truncated) and note why.
          const reason = String((error as Error).message).replace(/\s+/g, ' ').trim()
          body = [
            '- Memory summary unavailable: ' + reason,
            '',
            '<details><summary>raw transcript</summary>',
            '',
            rendered.render.slice(0, 4000),
            '',
            '</details>',
          ].join('\n')
        }
      }

      const dbPath = 'session:' + sessionID
      const file = writeCapture(memoryDir, body, sessionID, rendered.turnId, dbPath)
      console.log('[local-memory] captured turn ' + rendered.turnId + ' -> ' + file)
    }

    // ---- search: memory_search tool scans ALL daily files ----
    if (opts.searchEnabled) {
      const reg = await ctx.tool.transform((editor) => {
        editor.add({
          name: 'memory_search',
          description:
            'Search past conversation memories across all daily .memsearch/memory/YYYY-MM-DD.md files. '
            + 'Unlike the injected recent-memory block (only the recent-window days), this searches every '
            + 'historical file using pure keyword/substring scoring — no embeddings, no external services. '
            + 'Use it when the user asks about something that may predate the injected window, or when '
            + 'the injected memories mention only part of an older topic.',
          input: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query — keywords or a short phrase to find in past memory entries.',
              },
              top_k: {
                type: 'number',
                description: 'Number of matching turn entries to return (default: 5, max: ' + opts.searchMaxResults + ').',
              },
            },
            required: ['query'],
            additionalProperties: false,
          } as any,
          async execute(input: any) {
            const directory = projectDir
            const memoryDir = memoryDirFor(directory)
            const topK = Math.min(
              Math.max(1, Math.floor(Number(input?.top_k ?? 5))),
              opts.searchMaxResults,
            )
            const result = searchMemories(memoryDir, String(input?.query ?? ''), topK)
            return { content: formatSearchResults(String(input?.query ?? ''), result, opts.searchMaxLinesPerResult) }
          },
        })
      })
      cleanups.push(() => { void reg.dispose() })
    }

    // ---- inject: fold recent memories into the request's system[] ----
    if (opts.injectEnabled) {
      const reg = await ctx.session.hook('context', (request) => {
        try {
          const memoryDir = memoryDirFor(projectDir)
          const memories = recentMemories(memoryDir, opts.injectDays, opts.injectMaxLinesPerFile)
          if (!memories) return
          const block = buildMemoryBlock(memories, opts.injectDays)
          mergeSystemMemory(request.system, block)
        } catch (error) {
          console.warn('[local-memory] inject failed: ' + (error as Error).message)
        }
      })
      cleanups.push(() => { void reg.dispose() })
    }

    // ---- capture: summarize each finished turn and append to the daily file ----
    if (opts.captureEnabled) {
      const abort = new AbortController()
      cleanups.push(() => abort.abort())
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
            if (event.type !== 'session.idle') continue
            const sessionID = (event as any).data?.sessionID
            if (!sessionID) continue
            if (scratchSessions.has(sessionID)) continue // ignore our own scratch sessions
            enqueue(() => processIdleSession(sessionID))
          }
        } catch (error) {
          if (!abort.signal.aborted) {
            console.warn('[local-memory] event subscription ended: ' + (error as Error).message)
          }
        }
      })()
    }

    return () => {
      for (const fn of cleanups) {
        try { fn() } catch { /* best-effort */ }
      }
    }
  },
})

export { PLUGIN_NAME }

/**
 * Merge the memory block into a mutable SystemPart[] array in place without
 * growing it. The first system part carries the block; a previously injected
 * block (identified by MARKER) is replaced so repeated hook calls stay idempotent.
 */
function mergeSystemMemory(system: Array<{ type: 'text'; text: string }>, memoryText: string): void {
  if (!Array.isArray(system)) return
  if (system.length === 0) {
    system.push({ type: 'text', text: memoryText })
    return
  }
  const first = system[0]
  const existing = (first && typeof first.text === 'string') ? first.text : ''
  const markerIndex = existing.indexOf(MARKER)
  const base = markerIndex === -1 ? existing : existing.slice(0, markerIndex).replace(/\n+$/, '')
  const merged = base ? base + '\n\n' + memoryText : memoryText
  system[0] = { type: 'text', text: merged }
}