import { Component, Injector } from '@angular/core'
import { BaseTabComponent } from 'tabby-core'
import { MuxService } from './mux.service'
import { I18n } from './i18n'

/**
 * The "no windows here" page: opened when a mux operation leaves this OS
 * window without a single listed window (windows pulled into other hosts,
 * last one closed). The host's own welcome component is not exported from
 * tabby-core, and this page can offer mux actions anyway. A non-Split tab,
 * so the adoption logic ignores it.
 */
@Component({
    selector: 'mux-empty-tab',
    template: `
        <div class="mux-empty">
            <i class="fas fa-window-restore"></i>
            <div class="mux-empty-title">{{ title }}</div>
            <div class="mux-empty-hint">{{ hint }}</div>
            <div class="mux-empty-actions">
                <button class="btn btn-primary" (click)="newWindow()">{{ newText }}</button>
                <button class="btn btn-secondary" (click)="newSession()">{{ newSessionText }}</button>
            </div>
        </div>
    `,
    styles: [`
        :host { display: block; height: 100%; }
        .mux-empty {
            height: 100%;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 10px;
            color: var(--theme-fg, #ccc);
        }
        .mux-empty i { font-size: 42px; opacity: .25; }
        .mux-empty-title { font-size: 15px; opacity: .9; }
        .mux-empty-hint { font-size: 13px; opacity: .5; max-width: 420px; text-align: center; }
        .mux-empty-actions { display: flex; gap: 8px; margin-top: 8px; }
    `],
})
export class MuxEmptyTabComponent extends BaseTabComponent {
    hint = this.i18n.t('mux.empty.hint')
    newText = this.i18n.t('mux.newWindow').replace(/^Mux: /, '')
    newSessionText = this.i18n.t('mux.newSession').replace(/^Mux: /, '')

    // Resolved at construction, not as a constructor param: mux.service
    // imports this component, so a param typed MuxService would put the
    // class reference into emitDecoratorMetadata and hit the circular-import
    // TDZ while both modules are still evaluating (same rule as commands.ts).
    private mux!: MuxService

    constructor (
        injector: Injector,
        private i18n: I18n,
    ) {
        super(injector)
        this.mux = injector.get(MuxService)
        // Plain field, not a getter - the 1.0.231 typings declare the base
        // `title` as a property, and an accessor override trips TS2611.
        this.title = this.i18n.t('mux.empty.title')
        this.setTitle(this.title)
    }

    newWindow (): void {
        void this.mux.newWindow()
    }

    newSession (): void {
        void this.mux.createSessionWithWindow()
    }

    // Close as soon as the situation resolves itself (a window came back).
    async ngOnDestroy () {
        super.ngOnDestroy()
    }
}
