/** Store and stream MP4 scenery without loading the whole video into memory. */
import { randomUUID } from 'node:crypto'
import { open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'

export const MAX_BACKGROUND_VIDEO_BYTES = 100 * 1024 * 1024

function uploadError(message, status = 400) {
  return Object.assign(new Error(message), { status })
}

export async function importBackgroundVideo(directory, request) {
  if (request.headers['content-type']?.split(';', 1)[0] !== 'video/mp4') {
    throw uploadError('请选择 MP4 视频。', 415)
  }
  if (Number(request.headers['content-length']) > MAX_BACKGROUND_VIDEO_BYTES) {
    throw uploadError('背景视频不能超过 100 MB。', 413)
  }

  const temporary = join(directory, `.background-${randomUUID()}.tmp`)
  const file = await open(temporary, 'wx', 0o600)
  try {
    let size = 0
    let signature = Buffer.alloc(0)
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      size += chunk.length
      if (size > MAX_BACKGROUND_VIDEO_BYTES) throw uploadError('背景视频不能超过 100 MB。', 413)
      if (signature.length < 12) {
        signature = Buffer.concat([signature, chunk.subarray(0, 12 - signature.length)])
        if (signature.length === 12 && signature.toString('ascii', 4, 8) !== 'ftyp') {
          throw uploadError('无法识别 MP4 视频。', 415)
        }
      }
      await file.writeFile(chunk)
    }
    if (signature.length < 12) throw uploadError('MP4 视频文件不完整。', 415)
    await file.close()
    await rename(temporary, join(directory, 'background.mp4'))
  } finally {
    await file.close()
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}

function videoByteRange(header, size) {
  if (!header) return { start: 0, end: size - 1 }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match || (!match[1] && !match[2])) return
  const first = Number(match[1]), last = match[2] ? Number(match[2]) : size - 1
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return
  const start = match[1] ? first : Math.max(0, size - last)
  const end = match[1] ? Math.min(size - 1, last) : size - 1
  if (start <= end && start < size) return { start, end }
}

export async function streamBackgroundVideo(request, response, path) {
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    const range = videoByteRange(request.headers.range, size)
    const headers = {
      'accept-ranges': 'bytes',
      'content-type': 'video/mp4',
      'cache-control': 'private, max-age=60',
      'x-content-type-options': 'nosniff',
    }
    if (!range) {
      response.writeHead(416, { ...headers, 'content-range': `bytes */${size}` })
      response.end()
      return
    }
    const { start, end } = range
    headers['content-length'] = end - start + 1
    if (request.headers.range) headers['content-range'] = `bytes ${start}-${end}/${size}`
    response.writeHead(request.headers.range ? 206 : 200, headers)
    if (request.method === 'HEAD') response.end()
    else await pipeline(file.createReadStream({ start, end, autoClose: false }), response)
  } catch (error) {
    if (!response.headersSent) throw error
    // A client that switches conversations may close a video stream early.
    response.destroy()
  } finally {
    await file.close()
  }
}
