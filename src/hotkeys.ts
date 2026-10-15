import { Injectable, Injector } from '@angular/core'
import { HotkeyDescription, HotkeyProvider } from 'tabby-core'
import { MUX_COMMANDS } from './commands'
import { I18n } from './i18n'

/**
 * Hotkey descriptions are one-per-command; `<id>` maps onto the
 * `hotkeys.mux.*` config subtree declared in MuxConfigProvider.
 *
 * Resolved through the Injector inside provide() on purpose: this provider is
 * instantiated from HotkeysService's own constructor, and any synchronous
 * service injection that transitively touches HotkeysService would be a DI
 * creation cycle that silently kills the plugin.
 */
@Injectable()
export class MuxHotkeyProvider extends HotkeyProvider {
    constructor (private injector: Injector) {
        super()
    }

    async provide (): Promise<HotkeyDescription[]> {
        const i18n = this.injector.get(I18n)
        return MUX_COMMANDS.map(spec => {
            const n = spec.id.match(/select-window-(\d)$/)?.[1]
            return { id: spec.id, name: n ? i18n.t(spec.labelKey, { n }) : i18n.t(spec.labelKey) }
        })
    }
}
