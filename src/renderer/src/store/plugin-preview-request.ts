import { create } from 'zustand'

type PluginPreviewRequest = { marketplaceSourceId: string; pluginKey: string }

/** A catalog plugin asked for from outside Settings; the plugin manager opens its page. */
export const usePluginPreviewRequestStore = create<{ request: PluginPreviewRequest | null }>()(
  () => ({ request: null })
)

export function requestPluginPreview(request: PluginPreviewRequest): void {
  usePluginPreviewRequestStore.setState({ request })
}
