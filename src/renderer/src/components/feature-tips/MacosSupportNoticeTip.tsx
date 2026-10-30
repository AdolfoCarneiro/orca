import { useEffect, useState, type JSX } from 'react'
import type { MacosUpgradeSupport } from '../../../../shared/macos-upgrade-support'
import { translate } from '@/i18n/i18n'
import { MacosSupportNoticeDialog } from './MacosSupportNoticeDialog'

export function MacosSupportNoticeTip({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): JSX.Element {
  const [support, setSupport] = useState<MacosUpgradeSupport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void Promise.resolve(window.api.app.getMacosUpgradeSupport?.())
      .then((result) => {
        if (!cancelled) {
          setSupport(result ?? null)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const openUrl = async (url: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.api.shell.openUrl(url)
    } catch {
      setError(translate('macosSupport.openError', 'Could not open the guide. Try again.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <MacosSupportNoticeDialog
      open={open}
      onOpenChange={onOpenChange}
      support={support}
      busy={busy}
      error={error}
      onOpenUrl={(url) => void openUrl(url)}
    />
  )
}
