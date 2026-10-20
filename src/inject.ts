// Injection: read the N most recent daily files and fold a compact snapshot into
// the request's system[] via opencode v2's session 'context' hook. The hook
// receives a mutable SessionContext whose `system: SystemPart[]` is edited in
// place (see mergeSystemMemory in index.ts).

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DAILY_FILE_RE, MARKER } from './constants.ts'

/**
 * Read the N most recent daily files, keeping headings and bullet lines.
 * Pure file read — no vector search; recent full-text recall is stable for
 * environment-fact memories (db addresses, ports, pitfalls).
 */
export function recentMemories(memoryDir: string, days: number, maxLinesPerFile: number): string {
  let files: string[]
  try {
    files = readdirSync(memoryDir).filter((f) => DAILY_FILE_RE.test(f)).sort()
  } catch {
    return ''
  }
  if (files.length === 0) return ''
  const picked = files.slice(-days)

  const out: string[] = []
  for (const file of picked) {
    let content: string
    try {
      content = readFileSync(join(memoryDir, file), 'utf-8')
    } catch {
      continue
    }
    const kept = content
      .split('\n')
      .filter((l) => /^#{2,4}\s/.test(l) || l.startsWith('- '))
      .slice(0, maxLinesPerFile)
    if (kept.length > 0) {
      out.push('[' + file + ']', ...kept)
    }
  }
  if (out.length === 0) return ''
  return out.join('\n')
}

/**
 * Build the injected memory block text (without the outer system array).
 */
export function buildMemoryBlock(memories: string, injectDays: number): string {
  return [
    MARKER,
    '',
    'Memories from recent sessions in this project (auto-captured, may be stale —',
    'verify against the live repo before acting on a specific claim).',
    'These are only the last ' + injectDays + ' day(s). If the topic may be older,',
    'call memory_search to search ALL historical daily memory files.',
    '',
    memories,
  ].join('\n')
}