import type { CollectedBundle, CollectBundleOptions } from './bundle'

export type BundleWorkerRequest = { id: number; options: CollectBundleOptions }

export type BundleWorkerResponse =
  | { id: number; ok: true; bundle: CollectedBundle }
  | { id: number; ok: false; error: string }
