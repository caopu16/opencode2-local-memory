import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderLastTurn, captureExists, writeCapture } from '../src/capture.ts'

/** Build the v2 self-contained user message (ctx.session.context output). */
function userMsg(id: string, text: string) {
  return { id, type: 'user', time: { created: 0 }, text }
}

function asstMsg(id: string, text: string, tools: string[] = []) {
  const content: any[] = [{ type: 'text', text }]
  for (const [i, t] of tools.entries()) {
    content.push({ type: 'tool', tool: t, state: { status: 'completed' } })
  }
  return {
    id, type: 'assistant', time: { created: 0 },
    model: { providerID: 'openai', id: 'gpt' },
    content,
  }
}

test('renders the last turn into a transcript with tool counts', () => {
  const messages = [
    userMsg('msg_old', 'old prompt'),
    asstMsg('a_old', 'old reply'),
    userMsg('msg_1', 'check the flyway migration'),
    asstMsg('a_1', 'found the V22 mismatch', ['read', 'read', 'grep']),
  ] as any
  const rendered = renderLastTurn(messages, 24000)
  assert.ok(rendered)
  assert.equal(rendered!.turnId, 'msg_1')
  assert.equal(rendered!.userText, 'check the flyway migration')
  assert.equal(rendered!.providerID, 'openai')
  assert.equal(rendered!.modelID, 'gpt')
  assert.match(rendered!.render, /=== Turn msg_1 ===/)
  assert.match(rendered!.render, /\[User\]: check the flyway migration/)
  assert.match(rendered!.render, /\[Assistant\]: found the V22 mismatch/)
  // The previous turn must not leak into this one.
  assert.doesNotMatch(rendered!.render, /old prompt/)
  // Tool calls compress to one counted line, highest count first.
  assert.match(rendered!.render, /\[Tools\]: read\u00d72, grep/)
})

test('returns null when the final turn has no real prompt', () => {
  const messages = [asstMsg('a_1', 'orphan reply')] as any
  assert.equal(renderLastTurn(messages, 24000), null)
})

test('captureExists is anchor-based and idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencode2-local-memory-cap-'))
  try {
    assert.equal(captureExists(dir, 'ses_x', 'msg_1'), false)
    writeCapture(dir, '- note', 'ses_x', 'msg_1', 'session:ses_x')
    assert.equal(captureExists(dir, 'ses_x', 'msg_1'), true)
    assert.equal(captureExists(dir, 'ses_x', 'msg_2'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
