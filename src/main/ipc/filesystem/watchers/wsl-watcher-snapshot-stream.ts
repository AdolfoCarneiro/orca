export type WslSnapshotEntry = {
  path: string
  type: string
  mtime: string
}

export type WslSnapshot = Map<string, WslSnapshotEntry>

const MAX_RECORD_CHARS = 10 * 1024 * 1024

function addSnapshotRecord(snapshot: WslSnapshot, record: string, distro: string): void {
  const firstTab = record.indexOf('\t')
  const secondTab = firstTab === -1 ? -1 : record.indexOf('\t', firstTab + 1)
  if (firstTab <= 0 || secondTab <= firstTab + 1) {
    return
  }
  const linuxPath = record.slice(secondTab + 1)
  if (!linuxPath.startsWith('/')) {
    return
  }
  const entry: WslSnapshotEntry = {
    type: record.slice(0, firstTab),
    mtime: record.slice(firstTab + 1, secondTab),
    path: `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//g, '\\')}`
  }
  snapshot.set(entry.path, entry)
}

function delimiterPrefixLength(input: string, delimiter: string): number {
  for (let length = delimiter.length - 1; length > 0; length--) {
    if (input.endsWith(delimiter.slice(0, length))) {
      return length
    }
  }
  return 0
}

export function createWslSnapshotStream(
  distro: string,
  startDelimiter: string,
  endDelimiter: string,
  onSnapshot: (snapshot: WslSnapshot) => void,
  onOverflow: () => void
): { write(chunk: string): void; dispose(): void } {
  let snapshot: WslSnapshot | null = null
  let carry = ''
  let disposed = false

  function retainTail(input: string, offset: number): void {
    const tail = input.slice(offset)
    // Own the small unfinished record instead of retaining its entire input chunk.
    carry = tail ? Buffer.from(tail, 'utf8').toString('utf8') : ''
  }

  function rejectFrame(): void {
    snapshot = null
    onOverflow()
  }

  return {
    write(chunk) {
      if (disposed) {
        return
      }
      const input = carry + chunk
      carry = ''
      let cursor = 0
      while (cursor < input.length) {
        if (!snapshot) {
          const start = input.indexOf(startDelimiter, cursor)
          if (start === -1) {
            retainTail(input, input.length - delimiterPrefixLength(input, startDelimiter))
            return
          }
          snapshot = new Map()
          cursor = start + startDelimiter.length
        }

        const end = input.indexOf(endDelimiter, cursor)
        const contentEnd =
          end === -1 ? input.length - delimiterPrefixLength(input, endDelimiter) : end
        let separator = input.indexOf('\0', cursor)
        while (separator !== -1 && separator < contentEnd) {
          if (separator - cursor > MAX_RECORD_CHARS) {
            rejectFrame()
            break
          }
          addSnapshotRecord(snapshot, input.slice(cursor, separator), distro)
          cursor = separator + 1
          separator = input.indexOf('\0', cursor)
        }
        if (!snapshot) {
          continue
        }
        if (contentEnd - cursor > MAX_RECORD_CHARS) {
          rejectFrame()
          continue
        }
        if (end === -1) {
          retainTail(input, cursor)
          return
        }
        addSnapshotRecord(snapshot, input.slice(cursor, end), distro)
        const complete = snapshot
        snapshot = null
        cursor = end + endDelimiter.length
        onSnapshot(complete)
      }
    },
    dispose() {
      disposed = true
      snapshot = null
      carry = ''
    }
  }
}
