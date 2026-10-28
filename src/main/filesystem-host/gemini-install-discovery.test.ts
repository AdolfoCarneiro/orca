import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { extractOAuthClientCredentials } from './gemini-install-discovery'

it('discovers the client from a real installation without spawning PATH lookup subprocesses', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-gemini-install-'))
  try {
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, process.platform === 'win32' ? 'gemini.cmd' : 'gemini'), '', {
      mode: 0o755
    })
    const source = join(
      root,
      'node_modules',
      '@google',
      'gemini-cli-core',
      'dist',
      'src',
      'code_assist'
    )
    mkdirSync(source, { recursive: true })
    writeFileSync(
      join(source, 'oauth2.js'),
      "const OAUTH_CLIENT_ID = 'client'; const OAUTH_CLIENT_SECRET = 'secret';"
    )
    expect(await extractOAuthClientCredentials(root, bin)).toEqual({
      clientId: 'client',
      clientSecret: 'secret'
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
