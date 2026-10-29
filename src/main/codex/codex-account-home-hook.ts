import {
  CODEX_HOOK_LAUNCH_WAIT_MS,
  readEveryKnownCodexHookHashes,
  readKnownCodexHookAnswer,
  resolveCodexHookAnswerForLaunch
} from './codex-hook-hash-lookup'
import { getInPlaceCodexHookHome } from './codex-hook-orca-approvals'
import {
  reconcileCodexHookEntriesInHome,
  removeRealHomeCodexHookForOptOut
} from './codex-real-home-hook-install'

// Preserve the account's hooks and approvals; only a Codex launch waits for hash resolution.
export async function reconcileCodexAccountHomeHook(
  homePath: string,
  isEnabled: () => boolean,
  launchesCodex: boolean,
  isCurrent = () => true
): Promise<'settled' | 'unavailable'> {
  if (!isCurrent()) {
    return 'settled'
  }
  const home = getInPlaceCodexHookHome(homePath)
  if (!isEnabled()) {
    return (await removeRealHomeCodexHookForOptOut(
      readEveryKnownCodexHookHashes(),
      home,
      isCurrent
    )) === 'removed'
      ? 'settled'
      : 'unavailable'
  }
  const answer =
    (await resolveCodexHookAnswerForLaunch(launchesCodex ? CODEX_HOOK_LAUNCH_WAIT_MS : 0)) ??
    readKnownCodexHookAnswer()
  if (answer?.kind === 'refused' || (answer?.kind === 'pending' && answer.codexMissing)) {
    return 'unavailable'
  }
  return reconcileCodexHookEntriesInHome(home, {
    hashes: answer?.kind === 'hashes' ? answer.hashes : null,
    isEnabled: () => isCurrent() && isEnabled(),
    convertOlderForms: false
  })
}
