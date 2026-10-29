import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forwardedPushOrigin, structuredPushOccurrence } from './structured-push-identity'
import { addEnvironmentFromPairingCode } from '../../shared/runtime-environment-store'
import { encodePairingOffer } from '../../shared/pairing'
import {
  agentSessionAttentionKey,
  structuredAttentionOrigin,
  type AgentSessionAttentionEdge
} from '../../shared/agent-session-attention'

describe('structured push occurrence', () => {
  it('resolves the originating host fingerprint from the saved forwarding environment', () => {
    const folder = mkdtempSync(join(tmpdir(), 'orca-push-origin-'))
    try {
      const publicKey = Buffer.alloc(32, 1)
      const environment = addEnvironmentFromPairingCode(folder, {
        name: 'Host B',
        pairingCode: encodePairingOffer({
          v: 2,
          endpoint: 'ws://127.0.0.1:6768',
          deviceToken: 'device-token',
          publicKeyB64: publicKey.toString('base64')
        })
      })
      expect(forwardedPushOrigin(folder, environment.id)).toBe(
        createHash('sha256').update(publicKey).digest('base64url').slice(0, 16)
      )
      expect(forwardedPushOrigin(folder, 'removed-environment')).toBeUndefined()
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  it('preserves one host occurrence across forwarding and distinguishes a prompt re-raise', () => {
    const edge: AgentSessionAttentionEdge = {
      type: 'prompt',
      prompt: {
        scope: {
          workspaceId: 'workspace',
          executionHostId: 'local',
          wslDistro: null,
          workspaceKind: 'folder'
        },
        sessionId: 'session',
        promptId: 'prompt',
        raisedAt: 1,
        journalCursor: { epoch: 'journal', sequence: 1 }
      }
    }
    const key = agentSessionAttentionKey(edge)
    const original = structuredPushOccurrence(key, structuredAttentionOrigin(edge))
    expect(original).toHaveLength(43)
    expect(structuredPushOccurrence(key, structuredAttentionOrigin(structuredClone(edge)))).toBe(
      original
    )
    const raised = structuredClone(edge)
    raised.prompt.journalCursor = { epoch: 'journal', sequence: 2 }
    expect(structuredPushOccurrence(key, structuredAttentionOrigin(raised))).not.toBe(original)
    delete raised.prompt.journalCursor
    expect(structuredPushOccurrence(key, structuredAttentionOrigin(raised))).toBeUndefined()
  })
})
