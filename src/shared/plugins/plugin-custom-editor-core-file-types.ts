/**
 * Files Orca opens itself, or that usually hold secrets or drive tooling. A plugin editor may be
 * offered for them in the view toggle, but never opens them by default.
 */
const CORE_FILE_TYPES = new Set([
  'json',
  'jsonc',
  'json5',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'mts',
  'cts',
  'md',
  'mdx',
  'markdown',
  'mmd',
  'mermaid',
  'yaml',
  'yml',
  'toml',
  'ini',
  'csv',
  'tsv',
  'ipynb',
  'html',
  'htm',
  'css',
  'txt',
  'lock',
  'env',
  'pem',
  'key',
  'p12',
  'pfx'
])

const CORE_FILE_NAMES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'go.sum',
  'poetry.lock',
  'gemfile.lock',
  'composer.lock',
  'tsconfig.json',
  '.npmrc',
  'kubeconfig'
])

/** Whether a plugin editor whose `fileType` suffix matched this file may open it by default. */
export function customEditorMayOpenByDefault(filePath: string, fileType: string): boolean {
  const name = (filePath.split(/[\\/]/).at(-1) ?? '').toLowerCase()
  if (CORE_FILE_NAMES.has(name) || name === '.env' || name.startsWith('.env.')) {
    return false
  }
  return !CORE_FILE_TYPES.has(fileType.toLowerCase())
}
