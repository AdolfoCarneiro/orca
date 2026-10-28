import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

type EditableContextMenuPopup = {
  open: (template: MenuItemConstructorOptions[], point: { x: number; y: number }) => void
  close: () => void
}

export function createEditableContextMenuPopup(window: BrowserWindow): EditableContextMenuPopup {
  let currentMenu: Menu | null = null
  const close = (): void => {
    const menu = currentMenu
    currentMenu = null
    menu?.closePopup()
  }

  return {
    open: (template, point) => {
      close()
      const menu = Menu.buildFromTemplate(template)
      currentMenu = menu
      menu.popup({
        window,
        x: point.x,
        y: point.y,
        callback: () => {
          if (currentMenu === menu) {
            currentMenu = null
          }
        }
      })
    },
    close
  }
}
