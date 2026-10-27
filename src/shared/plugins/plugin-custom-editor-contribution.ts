import { z } from 'zod'
import { pluginIdSchema, pluginRelativePathSchema } from './manifest/plugin-manifest-fields'
import {
  pluginFieldDoc,
  pluginPathFieldDoc,
  PLUGIN_MANIFEST_V2_SINCE
} from './manifest/plugin-schema-field-docs'

export const PLUGIN_CUSTOM_EDITOR_LIMIT = 16
const PLUGIN_CUSTOM_EDITOR_FILE_TYPE_LIMIT = 16

export const PLUGIN_CUSTOM_EDITOR_PRIORITIES = ['default', 'option'] as const
export type PluginCustomEditorPriority = (typeof PLUGIN_CUSTOM_EDITOR_PRIORITIES)[number]

/** What the editor frame receives: the file's text, or its raw bytes. */
export const PLUGIN_CUSTOM_EDITOR_CONTENT_KINDS = ['text', 'bytes'] as const
export type PluginCustomEditorContentKind = (typeof PLUGIN_CUSTOM_EDITOR_CONTENT_KINDS)[number]

/** A file-name suffix without the leading dot: `excalidraw`, or a compound one like `excalidraw.json`. */
export const pluginCustomEditorFileTypeSchema = z
  .string()
  .max(64)
  .regex(
    /^[a-z0-9][a-z0-9+_-]*(?:\.[a-z0-9][a-z0-9+_-]*){0,2}$/,
    'must be a lowercase file suffix without the leading dot'
  )

export const pluginCustomEditorContributionSchema = z
  .object({
    id: pluginIdSchema.meta(
      pluginFieldDoc(
        "Editor id, unique among this plugin's custom editors. The reserved names `constructor` and `prototype` are refused.",
        PLUGIN_MANIFEST_V2_SINCE,
        ['excalidraw']
      )
    ),
    title: z
      .string()
      .min(1)
      .max(64)
      .meta(
        pluginFieldDoc(
          "Name shown in the editor's view toggle, beside Source.",
          PLUGIN_MANIFEST_V2_SINCE,
          ['Excalidraw']
        )
      ),
    fileTypes: z
      .array(pluginCustomEditorFileTypeSchema)
      .min(1)
      .max(PLUGIN_CUSTOM_EDITOR_FILE_TYPE_LIMIT)
      .meta(
        pluginFieldDoc(
          `File-name suffixes, without the leading dot, this editor opens. A longer suffix such as \`excalidraw.json\` matches only files ending in it. At most ${PLUGIN_CUSTOM_EDITOR_FILE_TYPE_LIMIT}.`,
          PLUGIN_MANIFEST_V2_SINCE,
          [['excalidraw', 'excalidraw.json']]
        )
      ),
    entry: pluginRelativePathSchema.meta(
      pluginPathFieldDoc(
        "HTML file rendered inside a sandboxed editor frame. It receives the open document's text and posts full-text edits back; it never gets a file path, file system or network access.",
        PLUGIN_MANIFEST_V2_SINCE,
        ['editor/index.html']
      )
    ),
    priority: z
      .enum(PLUGIN_CUSTOM_EDITOR_PRIORITIES)
      .optional()
      .meta(
        pluginFieldDoc(
          '`default` (the default) opens matching files in this editor; `option` only offers it in the view toggle, so files open in Source.',
          PLUGIN_MANIFEST_V2_SINCE,
          ['default']
        )
      ),
    contentKind: z
      .enum(PLUGIN_CUSTOM_EDITOR_CONTENT_KINDS)
      .optional()
      .meta(
        pluginFieldDoc(
          "`text` (the default) sends the file as text and accepts full-text edits. `bytes` sends the file's raw bytes, for binary formats such as spreadsheets; a `bytes` editor must also set `readonly`.",
          PLUGIN_MANIFEST_V2_SINCE,
          ['bytes']
        )
      ),
    readonly: z
      .boolean()
      .optional()
      .meta(
        pluginFieldDoc(
          'When true the editor only views files: Orca never applies its edits, and the install review says it opens rather than edits them.',
          PLUGIN_MANIFEST_V2_SINCE,
          [true]
        )
      )
  })
  .strict()
  .meta({
    id: 'CustomEditorContribution',
    description:
      'An editor for files of the listed types, shown in the editor tab beside Source. Requires the `sandboxed-ui` execution profile or higher.'
  })

export type PluginCustomEditorContribution = z.infer<typeof pluginCustomEditorContributionSchema>

/** Why read-only: Orca's save pipeline is text-only; editable byte editors would need byte drafts. */
export const PLUGIN_CUSTOM_EDITOR_BYTES_NEEDS_READONLY =
  'a custom editor with contentKind "bytes" must set readonly'

export function customEditorContentKind(editor: {
  contentKind?: PluginCustomEditorContentKind
}): PluginCustomEditorContentKind {
  return editor.contentKind ?? 'text'
}

/** The longest listed suffix the file name ends with, or null; a bare `.excalidraw` name never matches. */
export function matchCustomEditorFileType(
  filePath: string,
  fileTypes: readonly string[]
): string | null {
  const name = (filePath.split(/[\\/]/).at(-1) ?? '').toLowerCase()
  let best: string | null = null
  for (const fileType of fileTypes) {
    const suffix = `.${fileType}`
    if (name.length > suffix.length && name.endsWith(suffix)) {
      if (best === null || fileType.length > best.length) {
        best = fileType
      }
    }
  }
  return best
}
