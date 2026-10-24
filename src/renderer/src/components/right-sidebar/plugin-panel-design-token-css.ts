import { PANEL_DESIGN_TOKEN_ALLOWLIST } from '../../../../shared/plugins/plugin-panel-shell'

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
