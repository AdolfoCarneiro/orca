/** Declared access determines main’s checks; absent means the path must lie in a recognized project root. */
export type LocalFileAccess =
  /** A path the user named (gesture or persisted tab): a file read in place as a regular file, or a folder they opened listed. */
  | { kind: 'user-file' }
  /** A resource a document's content references (images): limited to that document's roots or folder. */
  | { kind: 'document-resource'; documentPath: string }
  /** An image a chat transcript or composer shows: any local image file; a network share only inside a project. */
  | { kind: 'chat-image' }
  /** A document the user opened: renaming it to any path, or adding files in its own folder. */
  | { kind: 'document-folder'; documentPath: string }

/** Main's refusal of a request that resolves outside every root it may serve. */
export const PATH_OUTSIDE_ALLOWED_DIRECTORIES =
  'Access denied: path resolves outside allowed directories'

// IPC preserves error messages without their classes.
export function isPathOutsideAllowedDirectoriesError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(PATH_OUTSIDE_ALLOWED_DIRECTORIES)
}
