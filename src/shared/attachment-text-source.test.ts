import { describe, expect, it } from 'vitest'
import {
  AttachmentTextSource,
  ATTACHMENT_TEXT_PAGE_BYTES,
  type AttachmentTextRequest
} from './attachment-text-source'
import { nativeChatTextAttachmentParts } from './native-chat-text-attachment-references'

function sourceFor(bytes: Buffer) {
  const requests: AttachmentTextRequest[] = []
  const source = new AttachmentTextSource('/file', async (request) => {
    requests.push(request)
    const content = bytes.subarray(request.offset, request.offset + request.length)
    return {
      snapshot: 'a'.repeat(64),
      size: bytes.length,
      contentBase64: content.toString('base64'),
      bytesRead: content.length,
      eof: request.offset + content.length === bytes.length
    }
  })
  return { source, requests }
}

describe('bounded attachment source', () => {
  it('reaches every character across UTF-8 seams and subpages with bounded source work and rows', async () => {
    for (const text of [
      '\ufeff'.concat('🙂é\r\n'.repeat(20_000)),
      'a'.repeat(1_000_000),
      '\n'.repeat(40_000)
    ]) {
      const { source, requests } = sourceFor(Buffer.from(text))
      let actual = ''
      await source.page(0)
      expect(requests).toHaveLength(1)
      expect(requests[0]!.length).toBeLessThanOrEqual(16 * 1024)
      for (let page = 0; page < source.pageCount; page++) {
        let display = await source.page(page)
        for (let subpage = 0; subpage < display.subpages; subpage++) {
          display = await source.page(page, subpage)
          expect(display.segments.length).toBeLessThanOrEqual(256)
          for (const segment of display.segments) {
            expect(Array.from(segment).length).toBeLessThanOrEqual(256)
          }
          actual += display.segments.join('')
        }
      }
      expect(actual).toBe(text)
      expect(await source.copyText()).toBe(text)
      expect(
        requests.slice(1).every((request) => request.expectedSnapshot === 'a'.repeat(64))
      ).toBe(true)
    }
  })

  it('keeps raw export available for invalid UTF-8 and refuses malformed/stalled/changed replies', async () => {
    const { source } = sourceFor(Buffer.from([0xff, 0, 0x80]))
    await expect(source.page(0)).rejects.toThrow()
    const saved: number[] = []
    for await (const chunk of source.bytes()) {
      saved.push(...chunk)
    }
    expect(saved).toEqual([0xff, 0, 0x80])
    await expect(source.copyText()).rejects.toThrow()
    for (const mutation of [
      { contentBase64: '!!!!' },
      { bytesRead: 0, contentBase64: '', eof: false },
      { contentBase64: 'YQ==', bytesRead: 1, eof: true },
      { size: 100 },
      { snapshot: 'no' }
    ]) {
      const broken = new AttachmentTextSource('/file', async () => ({
        snapshot: 'a'.repeat(64),
        size: 3,
        contentBase64: 'YWJj',
        bytesRead: 3,
        eof: true,
        ...mutation
      }))
      await expect(broken.page(0)).rejects.toThrow()
    }
  })

  it('serializes requests and cancels late results before display or export', async () => {
    let release!: () => void
    let started!: () => void
    const reading = new Promise<void>((resolve) => {
      started = resolve
    })
    let active = 0
    let maximum = 0
    const source = new AttachmentTextSource('/file', async () => {
      maximum = Math.max(maximum, ++active)
      started()
      await new Promise<void>((resolve) => {
        release = resolve
      })
      active--
      return { snapshot: 'a'.repeat(64), size: 1, contentBase64: 'YQ==', bytesRead: 1, eof: true }
    })
    const first = source.page(0)
    await reading
    const second = source.page(1)
    source.dispose()
    release()
    await expect(first).rejects.toThrow()
    await expect(second).rejects.toThrow()
    expect(maximum).toBe(1)
  })

  it('evicts old byte pages instead of accumulating the file during traversal', async () => {
    const { source, requests } = sourceFor(Buffer.alloc(ATTACHMENT_TEXT_PAGE_BYTES * 4, 97))
    await source.page(0)
    await source.page(1)
    await source.page(2)
    await source.page(1)
    expect(requests).toHaveLength(3)
    await source.page(0)
    expect(requests).toHaveLength(4)
  })
})

it('recognizes exact committed references while leaving terminal messages and surrounding text intact', () => {
  for (const path of [
    '/host/agent-session-attachments/12345678-1234-1234-1234-123456789abc/Pasted text.txt',
    'C:\\Orca\\agent-session-attachments\\12345678-1234-1234-1234-123456789abc\\both\'" names.txt'
  ]) {
    const token = ['@"', path.replace(/"/g, '\\"'), '"'].join('')
    const text = `before ${token} after`
    const parts = nativeChatTextAttachmentParts(text, true)
    expect(parts.map((part) => part.text).join('')).toBe(text)
    expect(parts.find((part) => part.path)?.path).toBe(path)
    expect(nativeChatTextAttachmentParts(text, false)).toEqual([{ text }])
  }
  for (const path of [
    '@/workspace/file.txt',
    '@/host/agent-session-attachments/12345678-1234-1234-1234-123456789abc/.upload.part'
  ]) {
    expect(nativeChatTextAttachmentParts(path, true)).toEqual([{ text: path }])
  }
})
