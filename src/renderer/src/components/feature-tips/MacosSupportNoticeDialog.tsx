import { useRef, type JSX } from 'react'
import { ArrowRight, ArrowUpRight, CircleCheck, Laptop, SquareTerminal } from 'lucide-react'
import type { MacosUpgradeSupport } from '../../../../shared/macos-upgrade-support'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'

export const MACOS_UPDATE_GUIDE_URL = 'https://support.apple.com/en-us/108382'
export const MACOS_COMPATIBILITY_URL = 'https://support.apple.com/en-us/102861'
export const OMARCHY_MAC_GUIDE_URL = 'https://omarchy.org/manual/mac-support/'

export function MacosSupportNoticeDialog({
  open,
  onOpenChange,
  support,
  busy = false,
  error,
  onOpenUrl
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  support: MacosUpgradeSupport | null
  busy?: boolean
  error?: string | null
  onOpenUrl: (url: string) => void
}): JSX.Element {
  const primaryButtonRef = useRef<HTMLButtonElement>(null)
  const canUpgrade = support?.macos13 === 'supported'
  const cannotUpgrade = support?.macos13 === 'unsupported'
  const primaryUrl = canUpgrade
    ? MACOS_UPDATE_GUIDE_URL
    : cannotUpgrade
      ? OMARCHY_MAC_GUIDE_URL
      : MACOS_COMPATIBILITY_URL

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-xl"
        scrollable
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          primaryButtonRef.current?.focus({ preventScroll: true })
        }}
      >
        <div className="space-y-6">
          <DialogHeader className="text-left">
            <Badge variant="outline" className="w-fit">
              {translate('macosSupport.eyebrow', 'Compatibility notice')}
            </Badge>
            <DialogTitle size="display">
              {translate('macosSupport.title', 'A heads-up for your Mac')}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'macosSupport.description',
                'Support for macOS 12 is ending soon. A future version of Orca will require macOS 13 or later.'
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-4 rounded-lg border border-border bg-card px-4 py-3 text-card-foreground">
            <Laptop className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {translate('macosSupport.currentVersion', 'macOS 12')}
              </p>
              <p className="text-xs text-muted-foreground">
                {translate('macosSupport.currentSystem', 'Monterey · your current system')}
              </p>
            </div>
            <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="shrink-0 text-right">
              <p className="text-sm font-medium">
                {translate('macosSupport.requiredVersion', 'macOS 13+')}
              </p>
              <p className="text-xs text-muted-foreground">
                {translate('macosSupport.futureRequirement', 'Upcoming requirement')}
              </p>
            </div>
          </div>

          <div className="space-y-3" aria-live="polite">
            <p className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
              {translate('macosSupport.nextStep', 'Your next step')}
            </p>
            <Card>
              <CardContent>
                <div className="space-y-3">
                  <div className="flex items-start gap-3">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      {cannotUpgrade ? (
                        <SquareTerminal className="size-4" aria-hidden />
                      ) : (
                        <ArrowUpRight className="size-4" aria-hidden />
                      )}
                    </div>
                    <div className="min-w-0 space-y-1.5">
                      <h3 className="text-sm font-semibold">
                        {canUpgrade
                          ? translate('macosSupport.upgradeTitle', 'Your Mac can upgrade')
                          : cannotUpgrade
                            ? translate('macosSupport.omarchyTitle', 'A new chapter for this Mac')
                            : translate('macosSupport.unknownTitle', 'Check your upgrade options')}
                      </h3>
                      <p className="text-sm leading-relaxed text-muted-foreground">
                        {canUpgrade
                          ? translate(
                              'macosSupport.upgradeDescription',
                              'Your Mac supports macOS 13 or later. Install a newer macOS version to keep receiving Orca updates.'
                            )
                          : cannotUpgrade
                            ? translate(
                                'macosSupport.omarchyDescription',
                                'Apple doesn’t support macOS 13 on this model. Omarchy is a Linux desktop you can explore to keep using Orca on an Intel Mac.'
                              )
                            : translate(
                                'macosSupport.unknownDescription',
                                'Check Apple’s supported models to see whether your Mac can run macOS 13. If it can’t, Omarchy is another path for Intel Macs.'
                              )}
                      </p>
                    </div>
                  </div>
                  {!canUpgrade ? (
                    <p className="border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">
                      {translate(
                        'macosSupport.omarchyBackup',
                        'Omarchy replaces macOS and can erase your drive. Back up your files and review its Mac compatibility guide before installing.'
                      )}
                    </p>
                  ) : null}
                </div>
              </CardContent>
            </Card>
            {!canUpgrade ? (
              <Button
                variant="link"
                size="xs"
                className="-ml-1.5"
                disabled={busy}
                onClick={() =>
                  onOpenUrl(cannotUpgrade ? MACOS_COMPATIBILITY_URL : OMARCHY_MAC_GUIDE_URL)
                }
              >
                {cannotUpgrade
                  ? translate('macosSupport.appleLink', 'View Apple’s supported models')
                  : translate('macosSupport.omarchyLink', 'Explore Omarchy for Intel Macs')}
                <ArrowUpRight className="size-3.5" aria-hidden />
              </Button>
            ) : null}
          </div>

          <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
            <CircleCheck className="size-4 shrink-0" aria-hidden />
            {translate('macosSupport.stillWorks', 'You can keep using this Orca version for now.')}
          </p>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <div className="border-t border-border pt-4">
            <DialogFooter className="sm:justify-between">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {translate('macosSupport.dismiss', 'Got it')}
              </Button>
              <Button
                ref={primaryButtonRef}
                disabled={busy}
                aria-busy={busy}
                onClick={() => onOpenUrl(primaryUrl)}
              >
                {canUpgrade
                  ? translate('macosSupport.updateAction', 'How to update macOS')
                  : cannotUpgrade
                    ? translate('macosSupport.omarchyAction', 'Explore Omarchy')
                    : translate('macosSupport.checkAction', 'Check compatibility')}
                <ArrowUpRight className="size-4" aria-hidden />
              </Button>
            </DialogFooter>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
