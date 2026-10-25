import { Injectable, Injector } from '@angular/core'
import { BaseTabComponent, MenuItemOptions, TabContextMenuItemProvider } from 'tabby-core'
import { MuxService } from './mux.service'
import { I18n } from './i18n'

/**
 * Adds the window pull-out entries to the native tab header context menu.
 * The provider runs once for the top-level tab and once for the focused
 * pane tab (SplitTabs); mux windows only match on the top-level call, so
 * pane menus stay untouched.
 */
@Injectable()
export class MuxTabContextMenu extends TabContextMenuItemProvider {
    // Sit after the core sections (TabManagement & friends default to 0).
    weight = 10

    constructor (private injector: Injector) {
        super()
    }

    async getItems (tab: BaseTabComponent): Promise<MenuItemOptions[]> {
        // Resolve lazily - never reference MuxService from constructor
        // metadata (circular-import TDZ, see commands.ts).
        const mux = this.injector.get(MuxService)
        const win = mux.windowForTab(tab)
        if (!win || !mux.hostsWindow(win)) {
            return []
        }
        const i18n = this.injector.get(I18n)
        const items: MenuItemOptions[] = [
            {
                label: i18n.t('mux.mw.moveToNew'),
                click: () => void mux.moveWindowTo(win, 'new'),
            },
        ]
        if (mux.moveTargetHosts().length) {
            items.push({
                label: i18n.t('mux.mw.moveToOther'),
                click: () => void mux.promptMoveWindow(win),
            })
        }
        return items
    }
}
