import { Injectable, Injector } from '@angular/core'
import { ToolbarButton, ToolbarButtonProvider } from 'tabby-core'
import { MuxService } from './mux.service'
import { I18n } from './i18n'

const NEW_SESSION_ICON =
    `<svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">` +
    `<path d="M1.5 2.5h5.2v11H1.5zM9.3 2.5h5.2v11H9.3z"/></svg>`

/**
 * Besides the button itself, this provider is the guaranteed early
 * instantiation hook for MuxService: appRoot builds toolbar button providers
 * at startup, which boots the mux session tracking and status bar regardless
 * of whether the palette is ever opened.
 */
@Injectable()
export class MuxToolbarButtonProvider extends ToolbarButtonProvider {
    constructor (private injector: Injector) {
        super()
        injector.get(MuxService)
    }

    provide (): ToolbarButton[] {
        const mux = this.injector.get(MuxService)
        const i18n = this.injector.get(I18n)
        return [
            {
                icon: NEW_SESSION_ICON,
                title: i18n.t('mux.toolbarButton'),
                weight: 1.6,
                click: () => void mux.createSessionWithWindow(),
            },
        ]
    }
}
