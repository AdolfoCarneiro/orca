import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  console.error('iOS Foundation checks require macOS with Xcode command-line tools.')
  process.exitCode = 1
} else {
  const { runProcess } = await import('@orca/process-host')
  const root = fileURLToPath(new URL('../', import.meta.url))
  const temporary = await mkdtemp(join(tmpdir(), 'orca-mobile-web-shell-checks-'))
  const executable = join(temporary, 'checks')
  const sources = [
    'MobileWebShellOrigin',
    'MobileWebShellGeneration',
    'MobileWebShellCsp',
    'MobileWebShellLoadState',
    'MobileWebShellResponseHeaders',
    'MobileWebShellBridge',
    'MobileWebShellAppliedProps',
    'MobileWebShellNavigationPolicy',
    'MobileWebShellAssetRead'
  ].map((name) => `ios/${name}.swift`)
  const env = { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
  async function run(program, args) {
    const result = await runProcess({ program, args, cwd: root, env, timeoutMs: 120_000 })
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    return result.code === 0 && !result.timedOut && !result.outputTruncated
  }
  try {
    const compiled = await run('xcrun', [
      'swiftc',
      '-swift-version',
      '5',
      '-O',
      '-o',
      executable,
      ...sources,
      'tests/MobileWebShellChecks.swift'
    ])
    process.exitCode = compiled && (await run(executable, [])) ? 0 : 1
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
