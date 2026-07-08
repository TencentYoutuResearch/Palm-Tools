import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { loadConfig } from '../src/domain/config.js'
import { extractReviewResult, formatReviewNote, type ReviewResult } from '../src/domain/run-loop.js'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((item) => rm(item, { recursive: true, force: true })))
})

// loadConfig only reads specops.toml from the given path — no git workspace needed.
async function workspaceWithConfig(toml: string): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'specops-review-'))
  cleanup.push(workspace)
  await writeFile(path.join(workspace, 'specops.toml'), toml)
  return workspace
}

const BASE = ['schema_version = 1', '', '[project]', 'name = "demo"', ''].join('\n')

describe('extractReviewResult (sentinel parsing)', () => {
  test('parses a valid result block and computes blocker from critical findings', () => {
    const text = [
      'Here is my review.',
      'REVIEW_RESULT_BEGIN',
      JSON.stringify({ summary: 'looks risky', findings: [{ category: 'spec', severity: 'critical', note: 'missing X' }] }),
      'REVIEW_RESULT_END',
    ].join('\n')
    const r = extractReviewResult(text, 'codebuddy')
    expect(r.inconclusive).toBeUndefined()
    expect(r.blocker).toBe(true)
    expect(r.summary).toBe('looks risky')
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]).toMatchObject({ category: 'spec', severity: 'critical' })
  })

  test('non-critical findings do not block', () => {
    const text = `REVIEW_RESULT_BEGIN\n${JSON.stringify({ summary: 'ok', findings: [{ category: 'quality', severity: 'minor', note: 'nit' }] })}\nREVIEW_RESULT_END`
    const r = extractReviewResult(text, 'm')
    expect(r.blocker).toBe(false)
    expect(r.inconclusive).toBeUndefined()
  })

  test('blocker is recomputed and ignores the agent self-reported flag', () => {
    // Agent lies: says blocker false but includes a critical finding.
    const text = `REVIEW_RESULT_BEGIN\n${JSON.stringify({ blocker: false, summary: 's', findings: [{ category: 'quality', severity: 'critical', note: 'real bug' }] })}\nREVIEW_RESULT_END`
    const r = extractReviewResult(text, 'm')
    expect(r.blocker).toBe(true)
  })

  test('missing markers => inconclusive, non-blocking', () => {
    const r = extractReviewResult('I could not finish the review.', 'm')
    expect(r.inconclusive).toBe(true)
    expect(r.blocker).toBe(false)
  })

  test('malformed JSON between markers => inconclusive', () => {
    const r = extractReviewResult('REVIEW_RESULT_BEGIN\n{ not json ]\nREVIEW_RESULT_END', 'm')
    expect(r.inconclusive).toBe(true)
    expect(r.blocker).toBe(false)
  })

  test('uses the last result block when multiple are present', () => {
    const text = [
      'REVIEW_RESULT_BEGIN', JSON.stringify({ summary: 'first', findings: [] }), 'REVIEW_RESULT_END',
      'REVIEW_RESULT_BEGIN', JSON.stringify({ summary: 'second', findings: [{ category: 'spec', severity: 'critical', note: 'n' }] }), 'REVIEW_RESULT_END',
    ].join('\n')
    const r = extractReviewResult(text, 'm')
    expect(r.summary).toBe('second')
    expect(r.blocker).toBe(true)
  })

  test('unknown category/severity are normalized to safe defaults', () => {
    const text = `REVIEW_RESULT_BEGIN\n${JSON.stringify({ summary: 's', findings: [{ category: 'weird', severity: 'fatal', note: 'n' }] })}\nREVIEW_RESULT_END`
    const r = extractReviewResult(text, 'm')
    expect(r.findings[0]).toMatchObject({ category: 'quality', severity: 'minor' })
    expect(r.blocker).toBe(false)
  })
})

describe('formatReviewNote', () => {
  test('lists critical findings as blockers and separates non-blocking ones', () => {
    const review: ReviewResult = {
      at: 'now', agent_model: 'm', blocker: true, summary: 'sum',
      findings: [
        { category: 'spec', severity: 'critical', note: 'must fix' },
        { category: 'quality', severity: 'minor', note: 'optional' },
      ],
    }
    const note = formatReviewNote(review)
    expect(note).toContain('sum')
    expect(note).toContain('[spec/critical] must fix')
    expect(note).toContain('Non-blocking')
    expect(note).toContain('[quality/minor] optional')
  })
})

describe('review config parsing', () => {
  test('defaults review.enabled to true when [review] is absent', async () => {
    const workspace = await workspaceWithConfig(BASE)
    const cfg = await loadConfig(workspace)
    expect(cfg.review.enabled).toBe(true)
    expect(cfg.review.model).toBeUndefined()
  })

  test('parses [review] enabled=false and model override', async () => {
    const workspace = await workspaceWithConfig(`${BASE}\n[review]\nenabled = false\nmodel = "opus"\n`)
    const cfg = await loadConfig(workspace)
    expect(cfg.review.enabled).toBe(false)
    expect(cfg.review.model).toBe('opus')
  })

  test('rejects a non-string review.model', async () => {
    const workspace = await workspaceWithConfig(`${BASE}\n[review]\nmodel = 123\n`)
    await expect(loadConfig(workspace)).rejects.toThrow(/review.model/)
  })

  test('rejects a non-boolean review.enabled', async () => {
    const workspace = await workspaceWithConfig(`${BASE}\n[review]\nenabled = "yes"\n`)
    await expect(loadConfig(workspace)).rejects.toThrow(/review.enabled/)
  })
})
