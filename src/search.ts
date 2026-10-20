// On-demand recall: pure JS keyword search over ALL daily memory files.
// No embeddings, no native deps — intentionally simple substring scoring.
//
// This is the practical replacement for @zilliz/memsearch-opencode's Milvus
// search: that path depends on the memsearch CLI -> pymilvus -> numpy, which
// crashes on CPUs below the x86-64-v2 baseline. Substring scoring is enough
// for environment-fact recall (db addresses, ports, file paths, errors).

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DAILY_FILE_RE } from './constants.ts'

export interface MemorySection {
  heading: string
  body: string[]
}

export interface SearchMatch {
  file: string
  heading: string
  body: string
  score: number
}

export interface SearchResult {
  files: number
  matches: SearchMatch[]
}

/** Split a daily file into `### HH:MM` turn blocks (heading + anchor + body). */
export function splitMemorySections(content: string): MemorySection[] {
  const lines = content.split('\n')
  const sections: MemorySection[] = []
  let current: MemorySection | null = null
  for (const line of lines) {
    if (/^###\s/.test(line)) {
      if (current && current.body.length > 0) sections.push(current)
      current = { heading: line.trim(), body: [] }
    } else if (current) {
      current.body.push(line)
    }
  }
  if (current && current.body.length > 0) sections.push(current)
  return sections
}

/**
 * Search all daily files (not just the injected recent window).
 * Scoring is intentionally transparent:
 *   - query is split on whitespace into terms (a Chinese phrase without spaces
 *     is one term);
 *   - each block's haystack = date filename + `### HH:MM` heading + body;
 *   - score = sum of term substring hits + 2 x full-query substring hits.
 * Returns the top `topK` blocks, newest-file-stable by score order.
 */
export function searchMemories(memoryDir: string, query: string, topK: number): SearchResult {
  let files: string[]
  try {
    files = readdirSync(memoryDir).filter((f) => DAILY_FILE_RE.test(f)).sort()
  } catch {
    return { files: 0, matches: [] }
  }

  const queryText = String(query || '').trim().toLowerCase()
  if (!queryText) return { files: files.length, matches: [] }
  const terms = queryText.split(/\s+/).filter(Boolean)
  if (terms.length === 0) return { files: files.length, matches: [] }

  const scored: SearchMatch[] = []
  for (const file of files) {
    let content: string
    try {
      content = readFileSync(join(memoryDir, file), 'utf-8')
    } catch {
      continue
    }
    for (const section of splitMemorySections(content)) {
      const body = section.body.join('\n')
      const haystack = ('[' + file + ']\n' + section.heading + '\n' + body).toLowerCase()
      let score = 0
      for (const term of terms) {
        if (!term) continue
        let index = haystack.indexOf(term)
        while (index !== -1) {
          score += 1
          index = haystack.indexOf(term, index + term.length)
        }
      }
      const exactCount = (haystack.split(queryText).length - 1)
      score += exactCount * 2
      if (score > 0) {
        scored.push({ file, heading: section.heading, body: body.trim(), score })
      }
    }
  }

  scored.sort((a, b) => b.score - a.score)
  return { files: files.length, matches: scored.slice(0, topK) }
}

/** Render search results as model-readable text. */
export function formatSearchResults(query: string, result: SearchResult, maxLinesPerResult = 12): string {
  const { files, matches } = result
  if (matches.length === 0) {
    return 'memory_search: no matches for "' + query + '" across ' + files + ' daily memory file(s).'
  }
  const lines = [
    'memory_search: ' + matches.length + ' match(es) for "' + query + '" across ' + files + ' daily memory file(s):',
  ]
  for (const match of matches) {
    lines.push('', '[' + match.file + '] ' + match.heading + ' (score ' + match.score + ')')
    const bodyLines = match.body.split('\n').slice(0, maxLinesPerResult)
    for (const line of bodyLines) {
      lines.push(line)
    }
    if (match.body.split('\n').length > maxLinesPerResult) {
      lines.push('… (' + (match.body.split('\n').length - maxLinesPerResult) + ' more line(s))')
    }
    lines.push('---')
  }
  return lines.join('\n')
}
