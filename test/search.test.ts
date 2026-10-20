import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { splitMemorySections, searchMemories, formatSearchResults } from '../src/search.ts'

function makeMemoryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'opencode2-local-memory-'))
  writeFileSync(join(dir, '2026-08-01.md'), [
    '# 2026-08-01',
    '',
    '## Session 10:00',
    '',
    '### 10:00',
    '<!-- session:a turn:msg_1 db:session:a -->',
    '- User asked about flyway migration V22.',
    '- Assistant found the config flyway validate issue.',
    '',
    '### 10:30',
    '<!-- session:a turn:msg_2 db:session:a -->',
    '- User reported copy password broken over IP.',
    '- copyText.ts fallback was added.',
    '',
  ].join('\n'))
  writeFileSync(join(dir, '2026-08-02.md'), [
    '# 2026-08-02',
    '',
    '## Session 09:00',
    '',
    '### 09:00',
    '<!-- session:b turn:msg_1 db:session:b -->',
    '- Discussed memory_search keyword matching.',
    '',
  ].join('\n'))
  return dir
}

test('splitMemorySections splits by ### headings', () => {
  const content = [
    '# day',
    '## Session 10:00',
    '### 10:00',
    'body-a',
    '### 10:30',
    'body-b',
  ].join('\n')
  const sections = splitMemorySections(content)
  assert.equal(sections.length, 2)
  assert.equal(sections[0].heading, '### 10:00')
  assert.equal(sections[0].body.join('\n'), 'body-a')
  assert.equal(sections[1].heading, '### 10:30')
})

test('searchMemories scans all daily files and ranks matches', () => {
  const dir = makeMemoryDir()
  try {
    const result = searchMemories(dir, 'flyway V22', 5)
    assert.equal(result.files, 2)
    assert.ok(result.matches.length >= 1)
    assert.equal(result.matches[0].file, '2026-08-01.md')
    assert.match(result.matches[0].body, /flyway migration V22/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('searchMemories returns no matches for absent query', () => {
  const dir = makeMemoryDir()
  try {
    const result = searchMemories(dir, 'nonexistent-topic-xyz', 5)
    assert.equal(result.files, 2)
    assert.equal(result.matches.length, 0)
    assert.match(formatSearchResults('nonexistent-topic-xyz', result), /no matches/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
