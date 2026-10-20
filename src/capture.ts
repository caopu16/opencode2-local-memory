// Capture pipeline: on session.idle, read the finished turn from the opencode v2
// session context, summarize it via ctx.generate, and append a markdown entry to
// <project>/.memsearch/memory/YYYY-MM-DD.md.
//
// v2 notes:
//   - The finished turn is read with ctx.session.context(), which returns the v2
//     SessionMessageInfo[] (self-contained messages, not the v1 {info, parts}).
//   - Summarization uses ctx.generate.text({ prompt, model }) — a single stateless
//     LLM call — instead of the v1 scratch-session + prompt + delete dance.

import { existsSync, mkdirSync, readdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Plugin } from '@opencode/plugin'
import { DAILY_FILE_RE, SUMMARIZE_SYSTEM, type Options } from './constants.ts'
import { todayStr, hhmmStr } from './util.ts'

type Ctx = Parameters<Plugin.Plugin['setup']>[0]

export interface RenderedTurn {
  /** The originating user message id, recorded in the anchor as turn:ID. */
  turnId: string
  userText: string
  render: string
  /** provider/model of the assistant reply, used as the summarizer fallback route. */
  providerID?: string
  modelID?: string
}

/** v2 messages are a loose union; read defensively by field presence. */
type AnyMessage = Record<string, any>

/** Plain text from a v2 user message (its `.text` field). */
function userText(msg: AnyMessage): string {
  return typeof msg?.text === 'string' ? msg.text.trim() : ''
}

/** Plain text from a v2 assistant message's content[] text parts. */
function assistantText(msg: AnyMessage): string {
  const content = Array.isArray(msg?.content) ? msg.content : []
  return content
    .filter((p: AnyMessage) => p?.type === 'text' && typeof p.text === 'string')
    .map((p: AnyMessage) => p.text)
    .join('\n')
    .trim()
}

/**
 * Render the LAST turn of a session from its full v2 message list.
 *
 * A turn is one real user message plus every assistant message and tool part
 * that follows it until the end (this runs at session.idle). Returns null when
 * the final turn has no real prompt.
 */
export function renderLastTurn(messages: AnyMessage[], maxChars: number): RenderedTurn | null {
  if (!Array.isArray(messages) || messages.length === 0) return null

  // Find the last real user message — the start of the finished turn.
  let startIndex = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (msg?.type === 'user' && userText(msg)) { startIndex = i; break }
  }
  if (startIndex === -1) return null

  const turnId = String(messages[startIndex].id)
  const uText = userText(messages[startIndex])

  const lines: string[] = ['=== Turn ' + turnId + ' ===', '', '[User]: ' + uText]
  const toolCounts: Record<string, number> = {}
  let providerID: string | undefined
  let modelID: string | undefined

  for (let i = startIndex + 1; i < messages.length; i += 1) {
    const msg = messages[i]
    if (msg?.type !== 'assistant') continue
    // v2 assistant message carries model as { providerID, id } under `model`.
    const model = msg.model
    if (model && typeof model === 'object') {
      if (typeof model.providerID === 'string') providerID = model.providerID
      if (typeof model.id === 'string') modelID = model.id
    }
    const text = assistantText(msg)
    if (text) lines.push('', '[Assistant]: ' + text)
    const content = Array.isArray(msg.content) ? msg.content : []
    for (const part of content) {
      if (part?.type === 'tool') {
        const name = part.tool || part.name
        if (name) toolCounts[name] = (toolCounts[name] ?? 0) + 1
      }
    }
  }

  const names = Object.keys(toolCounts)
  if (names.length > 0) {
    const summary = names
      .map((toolName) => ({ toolName, count: toolCounts[toolName] }))
      .sort((a, b) => b.count - a.count)
      .map(({ toolName, count }) => (count > 1 ? toolName + '\u00d7' + count : toolName))
      .join(', ')
    lines.push('', '[Tools]: ' + summary)
  }

  const render = lines.join('\n').slice(0, maxChars).trim()
  if (!render) return null
  return { turnId, userText: uText, render, providerID, modelID }
}

/** Whether this turn was already captured (anchor-based idempotency). */
export function captureExists(memoryDir: string, sessionId: string, turnId: string): boolean {
  let files: string[]
  try {
    files = readdirSync(memoryDir)
  } catch {
    return false
  }
  const anchor = '<!-- session:' + sessionId + ' turn:' + turnId + ' '
  for (const file of files) {
    if (!DAILY_FILE_RE.test(file)) continue
    try {
      if (readFileSync(join(memoryDir, file), 'utf-8').includes(anchor)) return true
    } catch { /* unreadable file = treat as not captured; worst case one duplicate */ }
  }
  return false
}

/** Append one memory entry to today's daily file. */
export function writeCapture(memoryDir: string, body: string, sessionId: string, turnId: string, dbPath: string): string {
  mkdirSync(memoryDir, { recursive: true })
  const today = todayStr()
  const hhmm = hhmmStr()
  const file = join(memoryDir, today + '.md')
  if (!existsSync(file)) {
    writeFileSync(file, '# ' + today + '\n\n', 'utf-8')
  }
  const anchor = '<!-- session:' + sessionId + ' turn:' + turnId + ' db:' + dbPath + ' -->'
  const entry = '### ' + hhmm + '\n' + anchor + '\n' + body.trim() + '\n\n'
  appendFileSync(file, entry, 'utf-8')
  return file
}

/**
 * Summarize a rendered turn with a single stateless ctx.generate.text call.
 *
 * v2 exposes a one-shot text-generation API, so there is no need to spin up a
 * scratch session (and therefore no capture-recursion risk from scratch idle
 * events). The summarizer system prompt is prepended to the transcript because
 * generate.text takes a single `prompt` string.
 */
export async function summarizeTurn(
  ctx: Ctx,
  opts: Options,
  rendered: RenderedTurn,
): Promise<string | null> {
  const providerID = opts.provider || rendered.providerID
  const modelID = opts.model || rendered.modelID
  if (!providerID || !modelID) {
    throw new Error('no model available for summarization (set provider+model in plugin config)')
  }

  const prompt = SUMMARIZE_SYSTEM + '\n\nTranscript:\n' + rendered.render

  const result = await ctx.generate.text({
    prompt,
    model: { providerID, id: modelID },
  })
  const text = typeof result?.text === 'string' ? result.text.trim() : ''
  return text || null
}