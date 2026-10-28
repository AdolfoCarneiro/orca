import { afterEach, describe, expect, it } from 'vitest'
import { createNativeHostWriteAdmission } from './browser-extension-native-host-write-admission'

const BODY_LIMIT = 64 * 1024 * 1024
const admissions: ReturnType<typeof createNativeHostWriteAdmission>[] = []

function admission() {
  const writes = createNativeHostWriteAdmission()
  admissions.push(writes)
  return writes
}

afterEach(() => {
  for (const writes of admissions.splice(0)) {
    writes.close()
  }
})

describe('native host write admission', () => {
  it('admits the outgoing protocol boundary and counts headers in the host byte budget', () => {
    const writes = admission()
    expect(writes.claim(BODY_LIMIT + 1)).toBeUndefined()
    const release = writes.claim(BODY_LIMIT)
    expect(release).toBeTypeOf('function')
    expect(writes.claim(1)).toBeUndefined()
    release?.()
    const smaller = writes.claim(BODY_LIMIT - 5)
    expect(smaller).toBeTypeOf('function')
    expect(writes.claim(1)).toBeTypeOf('function')
    expect(writes.claim(1)).toBeUndefined()
  })

  it('leaves one full-size frame for another host and bounds aggregate bytes', () => {
    const stalled = admission()
    const other = admission()
    const successor = admission()
    expect(stalled.claim(BODY_LIMIT)).toBeTypeOf('function')
    expect(stalled.claim(1)).toBeUndefined()
    const releaseOther = other.claim(BODY_LIMIT)
    expect(releaseOther).toBeTypeOf('function')
    expect(successor.claim(1)).toBeUndefined()
    releaseOther?.()
    expect(successor.claim(BODY_LIMIT)).toBeTypeOf('function')
    expect(other.claim(1)).toBeUndefined()
  })

  it('bounds small entries per host and across hosts, then restores a completed slot', () => {
    const hosts = Array.from({ length: 4 }, admission)
    const releases = hosts.map((host) => Array.from({ length: 256 }, () => host.claim(1)))
    expect(releases.flat().every((release) => typeof release === 'function')).toBe(true)
    expect(hosts[0].claim(1)).toBeUndefined()
    const successor = admission()
    expect(successor.claim(1)).toBeUndefined()
    releases[0][0]?.()
    expect(successor.claim(1)).toBeTypeOf('function')
    expect(hosts[0].claim(1)).toBeUndefined()
  })

  it('releases closed owners once, including late callbacks after successor admission', () => {
    const old = admission()
    const late = old.claim(BODY_LIMIT)
    expect(late).toBeTypeOf('function')
    old.close()
    const first = admission()
    const second = admission()
    const blocked = admission()
    expect(first.claim(BODY_LIMIT)).toBeTypeOf('function')
    expect(second.claim(BODY_LIMIT)).toBeTypeOf('function')
    old.close()
    late?.()
    late?.()
    expect(old.claim(1)).toBeUndefined()
    expect(blocked.claim(1)).toBeUndefined()
    first.close()
    expect(blocked.claim(BODY_LIMIT)).toBeTypeOf('function')
  })
})
