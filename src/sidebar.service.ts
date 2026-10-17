import { Injectable, Injector } from '@angular/core'
import { AppService, ConfigService } from 'tabby-core'
import { MuxService } from './mux.service'
import { I18n } from './i18n'
import { CONFIG_KEY } from './configKeys'

const STYLE_ID = 'tabby-mux-rail-style'
const RAIL_ID = 'tabby-mux-rail'

const STYLE = `
#tabby-mux-rail {
    position: relative;
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
    min-height: 40px;
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
#tabby-mux-rail .mux-rail-session.attached .mux-rail-index,
#tabby-mux-rail .mux-rail-session.attached .mux-rail-count { color: inherit; opacity: .8; }
#tabby-mux-rail .mux-rail-index {
    flex-shrink: 0;
    min-width: 14px;
    text-align: center;
    font-variant-numeric: tabular-nums;
    color: var(--theme-fg-more-2, #777);
}
#tabby-mux-rail .mux-rail-name {
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
}
#tabby-mux-rail .mux-rail-count {
    color: var(--theme-fg-more, #999);
    font-size: 11px;
    flex-shrink: 0;
}
#tabby-mux-rail .mux-rail-footer {
    display: flex;
    flex-wrap: nowrap;
    align-items: stretch;
    gap: 4px;
    margin: 4px;
    flex-shrink: 0;
}
#tabby-mux-rail .mux-rail-new {
    flex: 1;
    min-width: 0;
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
    white-space: nowrap;
}
#tabby-mux-rail .mux-rail-new:hover { background: var(--theme-bg-less, rgba(128,128,128,.25)); color: var(--theme-fg, #ccc); }
#tabby-mux-rail .mux-rail-tmpl {
    flex-shrink: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--theme-fg-more, #999);
    padding: 6px 9px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    white-space: nowrap;
}
#tabby-mux-rail .mux-rail-tmpl:hover { background: var(--theme-bg-less, rgba(128,128,128,.25)); color: var(--theme-fg, #ccc); }
#tabby-mux-rail .mux-rail-resizer {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 5px;
    cursor: col-resize;
    z-index: 10;
}
#tabby-mux-rail .mux-rail-resizer:hover,
#tabby-mux-rail .mux-rail-resizer.dragging {
    background: var(--theme-primary, #0d6efd);
}
`

/**
 * Left session rail - the outermost left element of the window.
 *
 * Rows show the session index as a separate element (configurable) left of
 * the name; unnamed sessions dynamically display the foreground window's
 * title. The templates section lives in the status bar / settings - here a
 * bookmark button next to "new session" mirrors the status bar's behavior.
 * The right edge is a drag handle resizing the rail (persisted on release).
 */
@Injectable({ providedIn: 'root' })
export class MuxSidebarService {
    private readonly mux: MuxService
    private readonly app: AppService
    private readonly config: ConfigService
    private readonly i18n: I18n

    private rail: HTMLElement | null = null
    private sessionsEl: HTMLElement | null = null
    private started = false
    private renderTimer: any = null

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
            setTimeout(tryMount, 200)
        }
        tryMount()
    }

    private mount (host: HTMLElement): void {
        this.rail = document.createElement('div')
        this.rail.id = RAIL_ID
        // Static shell: rebuilt only here, never during render().
        this.rail.innerHTML =
            `<div class="mux-rail-header"><i class="fas fa-layer-group"></i>` +
            `${escapeHtml(this.i18n.t('mux.rail.header'))}</div>` +
            `<div class="mux-rail-sessions"></div>` +
            `<div class="mux-rail-footer">` +
            `<button class="mux-rail-new">` +
            `<i class="fas fa-plus"></i>${escapeHtml(this.i18n.t('mux.rail.newSession'))}</button>` +
            `<button class="mux-rail-tmpl"><i class="fas fa-bookmark"></i><span class="mux-tpl-count"></span></button>` +
            `</div>` +
            `<div class="mux-rail-resizer"></div>`

        // First child = leftmost slot, before the profile tree / any sidebars.
        host.insertBefore(this.rail, host.firstChild)

        this.sessionsEl = this.rail.querySelector('.mux-rail-sessions')

        this.rail.addEventListener('click', ev => this.onClick(ev))
        this.rail.addEventListener('contextmenu', ev => this.onContextMenu(ev))
        const resizer = this.rail.querySelector('.mux-rail-resizer') as HTMLElement
        resizer.addEventListener('mousedown', ev => this.startResize(ev, resizer))

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
        if (!this.rail || !this.sessionsEl) {
            return
        }
        const settings = this.mux.settings
        const show = settings.sidebar.enabled && this.mux.sessions.length > 0

        document.documentElement.style.setProperty(
            '--mux-rail-w', `${Math.max(160, settings.sidebar.width)}px`)
        this.rail.classList.toggle('visible', show)
        if (!show) {
            return
        }

        const attached = this.mux.attachedSession
        const showIndex = settings.showSessionIndex
        const parts: string[] = []
        this.mux.sessions.forEach((s, index) => {
            const isAttached = s === attached
            const classes = [
                'mux-rail-session',
                isAttached ? 'attached' : '',
            ].filter(Boolean).join(' ')
            const indexEl = showIndex
                ? `<span class="mux-rail-index">${index}</span>`
                : ''
            const name = escapeHtml(this.mux.sessionDisplayName(s))
            parts.push(
                `<div class="${classes}" data-session-id="${s.id}" title="${name}">` +
                `${indexEl}` +
                `<span class="mux-rail-name">${name || '…'}</span>` +
                `<span class="mux-rail-count">${s.windows.length}</span></div>`)
        })
        this.sessionsEl.innerHTML = parts.join('')

        const countEl = this.rail.querySelector('.mux-tpl-count')
        const templateCount = this.mux.templates.length
        if (countEl) {
            countEl.textContent = templateCount ? `${templateCount}` : ''
        }
        const tmplBtn = this.rail.querySelector('.mux-rail-tmpl') as HTMLElement
        if (tmplBtn) {
            tmplBtn.title = this.i18n.t(templateCount ? 'mux.tmpl.browse' : 'mux.settings.tplSave')
        }
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
        if (target.closest('.mux-rail-tmpl')) {
            if (this.mux.templates.length) {
                void this.mux.browseTemplates()
            } else {
                void this.mux.saveSessionAsTemplatePrompt(this.mux.activeSession)
            }
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

    private onContextMenu (ev: MouseEvent): void {
        const target = ev.target as HTMLElement | null
        if (!target) {
            return
        }
        const sessionEl = target.closest('.mux-rail-session') as HTMLElement | null
        if (sessionEl) {
            const id = sessionEl.dataset['sessionId']
            const session = this.mux.sessions.find(s => s.id === id)
            if (session) {
                ev.preventDefault()
                this.mux.sessionContextMenu(session, ev)
            }
        }
    }

    /** Drag the right edge to resize; width persists on release. */
    private startResize (ev: MouseEvent, resizer: HTMLElement): void {
        ev.preventDefault()
        ev.stopPropagation()
        const startX = ev.clientX
        const startWidth = this.rail!.getBoundingClientRect().width
        // Keep the footer's "new session" + template buttons on one line.
        const minW = 160
        const maxW = 400
        let width = startWidth
        resizer.classList.add('dragging')
        document.body.style.cursor = 'col-resize'
        const onMove = (e: MouseEvent) => {
            width = Math.min(maxW, Math.max(minW, startWidth + (e.clientX - startX)))
            document.documentElement.style.setProperty('--mux-rail-w', `${Math.round(width)}px`)
        }
        const onUp = () => {
            resizer.classList.remove('dragging')
            document.body.style.cursor = ''
            document.removeEventListener('mousemove', onMove)
            document.removeEventListener('mouseup', onUp)
            if (Math.round(width) !== this.mux.settings.sidebar.width) {
                this.config.store[CONFIG_KEY].sidebar.width = Math.round(width)
                void this.config.save()
            }
        }
        document.addEventListener('mousemove', onMove)
        document.addEventListener('mouseup', onUp)
    }
}

function escapeHtml (text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}
