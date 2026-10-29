// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNativeChatNamingFailure } from '../tab-bar/use-native-chat-naming-failure'
import { NameGenerationFailedDialog, AutoRenameFailedDialog } from './AutoRenameFailedDialog'
import { useAppStore } from '@/store'
import { toast } from 'sonner'
import type { AppState } from '@/store/types'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

vi.mock('@/runtime/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapabilityState: () => 'unsupported'
}))
vi.mock('@/runtime/structured-agent-session-status-feed', () => ({
  getStructuredAgentSessionStatusFeed: () => null
}))
function ChatFailure({ failedAt }: { failedAt: number }) {
  const controls = useNativeChatNamingFailure({
    executionHostId: 'local',
    sessionId: 'chat',
    error: { message: 'No name', failedAt }
  })
  return (
    controls && (
      <NameGenerationFailedDialog
        open
        onOpenChange={() => {}}
        title="Chat name"
        description="Failure"
        error={controls.message}
        readFullOutput={controls.readFullOutput}
      />
    )
  )
}

const getBranchRenameFailureOutput =
  vi.fn<(args: { worktreeId: string }) => Promise<string | null>>()
const writeClipboardText = vi.fn<(text: string) => Promise<void>>()
const updateWorktreeMeta = vi.fn<AppState['updateWorktreeMeta']>()

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  useAppStore.setState({ updateWorktreeMeta })
  ;(window as unknown as { api: unknown }).api = {
    worktrees: { getBranchRenameFailureOutput },
    nativeChat: { getConversationNameFailureOutput: getBranchRenameFailureOutput },
    ui: { writeClipboardText }
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  document.body.innerHTML = ''
})

const EXCERPT_ERROR = 'Pi CLI command failed with code 1: No API key found for github-copilot.'

const onOpenChange = vi.fn<(open: boolean) => void>()

async function renderDialog(error = EXCERPT_ERROR): Promise<void> {
  await act(async () => {
    root.render(
      <AutoRenameFailedDialog
        open
        onOpenChange={onOpenChange}
        worktreeId="wt-1"
        executionHostId="ssh:builder"
        worktreeName="staghorn"
        error={error}
      />
    )
  })
}

describe('AutoRenameFailedDialog dismissal', () => {
  it('keeps Close temporary and persists Dismiss error on the workspace owner', async () => {
    getBranchRenameFailureOutput.mockResolvedValue(null)
    updateWorktreeMeta.mockResolvedValue({ ok: true })
    await renderDialog()
    const footer = document.querySelector('[data-slot="dialog-footer"]')
    await act(async () => footer?.querySelector<HTMLButtonElement>('button')?.click())
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(updateWorktreeMeta).not.toHaveBeenCalled()
    onOpenChange.mockClear()

    await act(async () => {
      const dismiss = Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent === 'Dismiss error'
      )
      dismiss?.click()
    })

    expect(updateWorktreeMeta).toHaveBeenCalledWith(
      'wt-1',
      { firstAgentMessageRenameError: null },
      { executionHostId: 'ssh:builder' }
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('reports a failed dismissal and leaves the dialog available to retry', async () => {
    getBranchRenameFailureOutput.mockResolvedValue(null)
    updateWorktreeMeta.mockResolvedValue({ ok: false, error: 'Server disconnected' })
    await renderDialog()
    const dismiss = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Dismiss error'
    )
    await act(async () => dismiss?.click())

    expect(toast.error).toHaveBeenCalledWith('Server disconnected')
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(dismiss?.disabled).toBe(false)
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(EXCERPT_ERROR)
  })
})

describe('AutoRenameFailedDialog full output', () => {
  it('shows the full CLI output fetched from main when available', async () => {
    getBranchRenameFailureOutput.mockResolvedValueOnce(
      'Pi exited with code 1.\n\n[stderr]\nNo API key found for github-copilot.\nUse /login to log in.'
    )
    await renderDialog()
    expect(getBranchRenameFailureOutput).toHaveBeenCalledWith({ worktreeId: 'wt-1' })
    expect(document.body.textContent).toContain('[stderr]')
    expect(document.body.textContent).toContain('Use /login to log in.')
  })

  it('refreshes and copies a new chat diagnostic while its identical-message dialog stays open', async () => {
    getBranchRenameFailureOutput.mockResolvedValueOnce('run A output')
    await act(async () => root.render(<ChatFailure failedAt={1} />))
    expect(document.body.textContent).toContain('run A output')
    getBranchRenameFailureOutput.mockResolvedValueOnce('run B output')
    await act(async () => root.render(<ChatFailure failedAt={2} />))
    expect(document.body.textContent).not.toContain('run A output')
    expect(document.body.textContent).toContain('run B output')
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Copy error"]')?.click()
    )
    expect(writeClipboardText).toHaveBeenCalledWith('run B output')
  })

  it('falls back to the persisted excerpt when main holds no capture', async () => {
    getBranchRenameFailureOutput.mockResolvedValueOnce(null)
    await renderDialog()
    expect(document.body.textContent).toContain(EXCERPT_ERROR)
  })

  it('falls back to the persisted excerpt when the fetch rejects', async () => {
    getBranchRenameFailureOutput.mockRejectedValueOnce(new Error('ipc unavailable'))
    await renderDialog()
    expect(document.body.textContent).toContain(EXCERPT_ERROR)
  })

  it('refetches full output when a retry changes the persisted error', async () => {
    getBranchRenameFailureOutput.mockResolvedValueOnce('first run full output')
    await renderDialog('first run excerpt')
    expect(document.body.textContent).toContain('first run full output')

    getBranchRenameFailureOutput.mockResolvedValueOnce('second run full output')
    await renderDialog('second run excerpt')

    expect(getBranchRenameFailureOutput).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain('second run full output')
    expect(document.body.textContent).not.toContain('first run full output')
  })
})

// happy-dom has no intrinsic sizing; verify the declarations that contain unbroken output.
describe('AutoRenameFailedDialog unbroken output containment', () => {
  it('keeps the output surface shrinkable and breakable mid-token', async () => {
    getBranchRenameFailureOutput.mockResolvedValueOnce(`{"error":"${'A'.repeat(1000)}"}`)
    await renderDialog()

    const dialog = document.querySelector('[role="dialog"]')
    const output = dialog?.querySelector('pre')
    expect(output).toBeTruthy()
    expect(output?.textContent).toContain('A'.repeat(1000))

    // break-word preserves token min-content width; anywhere shrinks it.
    expect(output?.className).toContain('[overflow-wrap:anywhere]')
    expect(output?.className).not.toContain('break-words')

    // Grid children need min-w-0 to shrink below min-content.
    const gridChild = Array.from(dialog?.children ?? []).find((child) =>
      child.contains(output ?? null)
    )
    expect(gridChild?.className).toContain('min-w-0')
  })
})
