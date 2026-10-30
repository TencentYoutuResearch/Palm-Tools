/** Translate official dsh attachment references without replacing upload or storage. */
import { fileHandleText, offloadedImageText } from '@deepseek-ai/dsh-llm'

export async function nativeInput(messages, { attachments, codex, signal }) {
  const input = []
  for (const message of messages) for (const part of message.content) {
    signal?.throwIfAborted()
    if (part.type === 'text') { input.push({ type: 'text', text: part.text }); continue }
    if (part.type === 'file') {
      input.push({ type: 'text', text: fileHandleText(part.attachment, attachments?.fileHostPath(part.attachment)) })
      continue
    }
    if (part.type !== 'image') throw new Error(`不支持的用户输入类型：${part.type}`)
    if (!attachments) throw new Error('图片附件服务尚未就绪，请重试。')
    const path = attachments.imageHostPath(part.attachment)
    if (part.offloaded) {
      input.push({ type: 'text', text: offloadedImageText(part.attachment, path ? { readonlyPath: path } : undefined) })
      continue
    }
    const stored = await attachments.readImage(part.attachment, signal)
    if (codex && path) input.push({ type: 'localImage', path })
    else {
      const data = Buffer.from(stored.data).toString('base64')
      input.push(codex ? { type: 'image', url: `data:${stored.ref.mediaType};base64,${data}` } : { type: 'image', mimeType: stored.ref.mediaType, data })
    }
  }
  return input
}
