import { Injectable, Injector } from '@angular/core'
import { AppService, ConfigService } from 'tabby-core'
import { MuxService } from './mux.service'
import { I18n } from './i18n'

const STYLE_ID = 'tabby-mux-rail-style'
const RAIL_ID = 'tabby-mux-rail'

const STYLE = `
#tabby-mux-rail {
    display: none;
    flex-direction: column;
    flex-shrink: 0;
    width: var(--mux-rail-w, 150px);
    height: 100%;
    box-sizing: border-box;
    background: var(--theme-bg-more-2, #2b2b2b);
    color: var(--theme-fg, #ccc);
    font-size: 12px;
    user-select: none;
    overflow: hidden;
}
#tabby-mux-rail.visible { display: flex; }
#tabby-mux-rail .mux-rail-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px 6px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: .5px;
    color: var(--theme-fg-more, #999);
    text-transform: uppercase;
}
#tabby-mux-rail .mux-rail-sessions {
    flex: 1;
    overflow-y: auto;
    padding: 0 4px;
}
#tabby-mux-rail .mux-rail-session {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    margin: 1px 0;
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
}
#tabby-mux-rail .mux-rail-session:hover { background: var(--theme-bg-less, rgba(128,128,128,.25)); }
#tabby-mux-rail .mux-rail-session.attached {
    background: var(--theme-primary, #0d6efd);
    color: var(--theme-primary-fg, #fff);
}
#tabby-mux-rail .mux-rail-session.attached .mux-rail-count { color: inherit; opacity: .8; }
#tabby-mux-rail .mux-rail-session i { font-size: 11px; opacity: .8; flex-shrink: 0; }
#tabby-mux-rail .mux-rail-name { overflow: hidden; text-overflow: ellipsis; }
#tabby-mux-rail .mux-rail-count {
    margin-left: auto;
    color: var(--theme-fg-more, #999);
    font-size: 11px;
    flex-shrink: 0;
}
#tabby-mux-rail .mux-rail-new {
    margin: 4px;
    padding: 6px 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--theme-fg-more, #999);
    font-size: 12px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
}
#tabby-mux-rail .mux-rail-new:hover { background: var(--theme-bg-less, rgba(128,128,128,.25)); color: var(--theme-fg, #ccc); }
`

/**
 * Left session rail - the outermost left element of the window.
 *
 * Injected as the first child of appRoot's `.window` flex container, so it
 * sits to the LEFT of everything else Tabby places there (profile tree, any
 * plugin sidebars) and shrinks the content area by its width; xterm panes
 * refit through their ResizeObserver.
 */
@Injectable({ providedIn: 'root' })
export class MuxSidebarService {
    private readonly mux: MuxService
    private readonly app: AppService
    private readonly config: ConfigService
    private readonly i18n: I18n

    private rail: HTMLElement | null = null
    private started = false
    private renderTimer: any = null
    private mountTimer: any = null

    constructor (injector: Injector) {
        this.mux = injector.get(MuxService)
        this.app = injector.get(AppService)
        this.config = injector.get(ConfigService)
        this.i18n = injector.get(I18n)
    }

    start (): void {
        if (this.started) {
            return
        }
        this.started = true

        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = STYLE
        document.head.appendChild(style)

        this.mountWhenReady()

        this.mux.changed$.subscribe(() => this.scheduleRender())
        this.app.activeTabChange$.subscribe(() => this.scheduleRender())
        this.config.changed$.subscribe(() => this.scheduleRender())
        this.i18n.localeChanged$.subscribe(() => this.scheduleRender())
    }

    /** appRoot renders `.window` after Angular bootstrap - poll for it. */
    private mountWhenReady (): void {
        let attempts = 0
        const tryMount = () => {
            const host = document.querySelector('app-root .window')
            if (host) {
                this.mount(host as HTMLElement)
                return
            }
            if (++attempts > 300) {
                return // ~60s; give up quietly
            }
            this.mountTimer = setTimeout(tryMount, 200)
        }
        tryMount()
    }

    private mount (host: HTMLElement): void {
        this.rail = document.createElement('div')
        this.rail.id = RAIL_ID
        // First child = leftmost slot, before the profile tree / any sidebars.
        host.insertBefore(this.rail, host.firstChild)
        this.rail.addEventListener('click', ev => this.onClick(ev))
        this.scheduleRender()
    }

    private scheduleRender (): void {
        if (!this.rail || this.renderTimer !== null) {
            return
        }
        this.renderTimer = setTimeout(() => {
            this.renderTimer = null
            this.render()
        }, 50)
    }

    private render (): void {
        if (!this.rail) {
            return
        }
        const settings = this.mux.settings.sidebar
        const show = settings.enabled && this.mux.sessions.length > 0

        document.documentElement.style.setProperty(
            '--mux-rail-w', `${Math.max(80, settings.width)}px`)
        this.rail.classList.toggle('visible', show)
        if (!show) {
            return
        }

        const attached = this.mux.attachedSession
        const parts: string[] = []
        parts.push(
            `<div class="mux-rail-header"><i class="fas fa-layer-group"></i>` +
            `${escapeHtml(this.i18n.t('mux.rail.header'))}</div>`)
        parts.push('<div class="mux-rail-sessions">')
        for (const s of this.mux.sessions) {
            const isAttached = s === attached
            parts.push(
                `<div class="mux-rail-session ${isAttached ? 'attached' : ''}" ` +
                `data-session-id="${s.id}" title="${escapeHtml(s.name)}">` +
                `<i class="fas ${isAttached ? 'fa-circle' : 'fa-circle-thin'}"></i>` +
                `<span class="mux-rail-name">${escapeHtml(s.name)}</span>` +
                `<span class="mux-rail-count">${s.windows.length}</span></div>`)
        }
        parts.push('</div>')
        parts.push(
            `<button class="mux-rail-new" title="${escapeHtml(this.i18n.t('mux.newSession'))}">` +
            `<i class="fas fa-plus"></i>${escapeHtml(this.i18n.t('mux.rail.newSession'))}</button>`)
        this.rail.innerHTML = parts.join('')
    }

    private onClick (ev: MouseEvent): void {
        const target = ev.target as HTMLElement | null
        if (!target) {
            return
        }
        if (target.closest('.mux-rail-new')) {
            void this.mux.createSessionWithWindow()
            return
        }
        const sessionEl = target.closest('.mux-rail-session') as HTMLElement | null
        if (sessionEl) {
            const id = sessionEl.dataset['sessionId']
            const session = this.mux.sessions.find(s => s.id === id)
            if (session) {
                this.mux.switchToSession(session)
            }
        }
    }
}

function escapeHtml (text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}
