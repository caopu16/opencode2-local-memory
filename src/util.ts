// Small shared helpers used by capture / inject / search.

import { join } from 'node:path'

/** Local date YYYY-MM-DD (local timezone so daily files follow human days). */
export function todayStr(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return [now.getFullYear(), p(now.getMonth() + 1), p(now.getDate())].join('-')
}

/** Local time HH:MM. */
export function hhmmStr(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return p(now.getHours()) + ':' + p(now.getMinutes())
}

/**
 * Memory directory, same resolution rule as the @zilliz/memsearch-opencode
 * plugin: <project>/.memsearch/memory, or $MEMSEARCH_DIR/memory when set.
 */
export function memoryDirFor(projectDir: string): string {
  const base = process.env.MEMSEARCH_DIR
  return base ? join(base, 'memory') : join(projectDir, '.memsearch', 'memory')
}
