import {
  isCaseInsensitiveRuntimeRoot,
  isWindowsAbsolutePathLike
} from '../../../../shared/cross-platform-path'
import { fileUriToFilesystemPath, filesystemPathToFileUri } from '../../../../shared/file-uri-path'
import { projectMarkdownHrefForClipboard } from './markdown-internal-links'
import { resolveMarkdownPreviewHref } from './markdown-preview-links'

export function isRelativeClipboardLink(href: string): boolean {
  const projected = projectMarkdownHrefForClipboard(href)
  return Boolean(projected && !/^(?:[a-z][a-z\d+.-]*:|[/\\#?])/i.test(projected))
}

export function resolveRelativeClipboardLink(href: string, filePath: string): string | null {
  if (!isRelativeClipboardLink(href)) {
    return null
  }
  const target = resolveMarkdownPreviewHref(href, filePath)
  return target?.protocol === 'file:' && fileUriToFilesystemPath(target) !== null
    ? target.toString()
    : null
}

export function rebaseClipboardLink(
  href: string,
  absoluteHref: string,
  destinationFilePath: string
): string {
  if (resolveRelativeClipboardLink(href, destinationFilePath) === absoluteHref) {
    return href
  }
  const target = new URL(absoluteHref)
  const targetPath = fileUriToFilesystemPath(target)
  if (targetPath === null) {
    return href
  }
  const canonicalTarget = new URL(filesystemPathToFileUri(targetPath))
  canonicalTarget.search = target.search
  canonicalTarget.hash = target.hash
  const destination = new URL(filesystemPathToFileUri(destinationFilePath))
  const windows = isWindowsAbsolutePathLike(targetPath)
  const caseInsensitive = isCaseInsensitiveRuntimeRoot(targetPath)
  const targetSegments = canonicalTarget.pathname.split('/')
  const directorySegments = destination.pathname.split('/').slice(0, -1)
  const equal = (left: string, right: string): boolean =>
    caseInsensitive ? left.toLowerCase() === right.toLowerCase() : left === right
  if (
    canonicalTarget.host !== destination.host ||
    windows !== isWindowsAbsolutePathLike(destinationFilePath) ||
    (windows && !equal(targetSegments[1] ?? '', directorySegments[1] ?? ''))
  ) {
    return href
  }
  let common = 0
  while (
    common < targetSegments.length &&
    common < directorySegments.length &&
    equal(targetSegments[common], directorySegments[common])
  ) {
    common++
  }
  const relative = [
    ...Array<string>(directorySegments.length - common).fill('..'),
    ...targetSegments.slice(common)
  ].join('/')
  return `${relative || './'}${canonicalTarget.search}${canonicalTarget.hash}`
}
