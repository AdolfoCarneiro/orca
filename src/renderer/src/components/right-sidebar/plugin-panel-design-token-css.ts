import { PANEL_THEME_TYPE } from '../../../../shared/plugins/plugin-panel-bridge'
import {
  fillPluginFrameShell,
  PANEL_DESIGN_TOKEN_ALLOWLIST
} from '../../../../shared/plugins/plugin-panel-shell'

/** Snapshot trusted computed tokens for isolated panels; strip structural CSS characters before inserting into the shell style block. */
export function buildPanelDesignTokenCss(): string {
  const styles = getComputedStyle(document.documentElement)
  const declarations: string[] = []
  for (const token of PANEL_DESIGN_TOKEN_ALLOWLIST) {
    const value = styles.getPropertyValue(token).trim()
    if (value.length > 0) {
      // Why prefixed: bare names collide with a panel's own shadcn/Tailwind variables.
      declarations.push(`--orca-${token.slice(2)}:${value.replaceAll(/[{}<>;]/g, '')}`)
    }
  }
  return declarations.join(';')
}

export function currentPanelColorScheme(): 'light' | 'dark' {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

export function fillPluginPanelShell(html: string): string {
  return fillPluginFrameShell(html, currentPanelColorScheme(), buildPanelDesignTokenCss())
}

export function pluginFrameThemeMessage(): {
  type: typeof PANEL_THEME_TYPE
  colorScheme: 'light' | 'dark'
  tokens: string
} {
  return {
    type: PANEL_THEME_TYPE,
    colorScheme: currentPanelColorScheme(),
    tokens: buildPanelDesignTokenCss()
  }
}

/** Restyles a loaded frame in place; remounting would discard the plugin's state. */
export function postPluginFrameTheme(frameWindow: Window | null | undefined): void {
  frameWindow?.postMessage(pluginFrameThemeMessage(), '*')
}
