import assert from 'node:assert/strict'
import test from 'node:test'
import {
  composeMonitorMessage,
  insertMonitorNewline,
  monitorAttachmentName,
  normalizeMonitorMessage,
} from '../src/lib/monitor_attachments.ts'

test('composes mobile-compatible attachment references after typed text', () => {
  assert.equal(
    composeMonitorMessage('review this', ['/tmp/kode-attachments/a/a.png', '/tmp/kode-attachments/a/b.zip']),
    'review this\n\nAttached file: /tmp/kode-attachments/a/a.png\nAttached file: /tmp/kode-attachments/a/b.zip',
  )
})

test('preserves internal newlines and appends exactly one submit LF', () => {
  assert.equal(normalizeMonitorMessage('line one\r\nline two\rline three\n'), 'line one\nline two\nline three\n')
})

test('reads attachment names from POSIX and Windows paths', () => {
  assert.equal(monitorAttachmentName('/tmp/kode-attachments/id/a.png'), 'a.png')
  assert.equal(monitorAttachmentName('D:\\Temp\\kode-attachments\\id\\b.zip'), 'b.zip')
})

test('Alt+Enter inserts a newline at the current selection', () => {
  assert.deepEqual(insertMonitorNewline('hello world', 5), {
    text: 'hello\n world',
    cursor: 6,
  })
  assert.deepEqual(insertMonitorNewline('hello world', 6, 11), {
    text: 'hello \n',
    cursor: 7,
  })
})
