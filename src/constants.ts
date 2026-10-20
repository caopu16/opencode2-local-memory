// Shared constants for opencode2-local-memory.

/** Plugin id / display name. */
export const PLUGIN_NAME = 'local-memory'

/**
 * Marker that opens this plugin's injected block inside the system prompt.
 *
 * opencode v2 injects memory by editing the mutable `system: SystemPart[]` of the
 * session 'context' hook. The marker lets the hook replace an earlier injected
 * block in place instead of stacking copies across turns, and lets the model
 * recognise the block as an auto-captured snapshot.
 */
export const MARKER = '<!-- opencode2-local-memory -->'

/** Daily memory file pattern, aligned with the @zilliz/memsearch-opencode plugin. */
export const DAILY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/

export interface Options {
  captureEnabled: boolean
  injectEnabled: boolean
  searchEnabled: boolean
  summarizeEnabled: boolean
  injectDays: number
  injectMaxLinesPerFile: number
  captureMaxChars: number
  summarizeMaxTokens: number
  summarizeTimeoutMs: number
  minPromptLength: number
  searchMaxResults: number
  searchMaxLinesPerResult: number
  provider: string
  model: string
}

export const DEFAULTS: Options = {
  captureEnabled: true,
  injectEnabled: true,
  searchEnabled: true,         // register memory_search tool (scans all daily files)
  summarizeEnabled: true,
  injectDays: 2,               // how many recent daily files are injected
  injectMaxLinesPerFile: 40,   // max lines injected per daily file
  captureMaxChars: 24000,      // max raw transcript chars sent to summarizer
  summarizeMaxTokens: 1200,
  summarizeTimeoutMs: 120000,
  minPromptLength: 8,          // skip capture when user message is shorter
  searchMaxResults: 20,        // memory_search max returned turn blocks per call
  searchMaxLinesPerResult: 12, // memory_search max body lines per returned block
  provider: '',                // empty = reuse the turn's own model
  model: '',
}

export const SUMMARIZE_SYSTEM = [
  'You are a third-person note-taker for an AI coding session.',
  'Record the transcript below as 3-10 markdown bullet points, each starting with "- ".',
  'Write in the same language as the [User] text (Chinese stays Chinese).',
  'Capture: what the user asked, what was actually done, concrete findings (file paths,',
  'commands, numbers, error messages), decisions made, and anything left pending.',
  'Prefer specifics over summary adjectives. Never invent facts absent from the transcript.',
  'Output ONLY the bullet points, with no preamble and no closing remark.',
].join('\n')
