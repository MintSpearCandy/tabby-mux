import { Injectable, Injector } from '@angular/core'
import { AppService, ConfigService } from 'tabby-core'
import { MuxService } from './mux.service'
import { I18n } from './i18n'
import { MuxSession } from './types'

const STYLE_ID = 'tabby-mux-statusbar-style'
const BAR_ID = 'tabby-mux-statusbar'

const STYLE = `
#tabby-mux-statusbar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    height: var(--mux-statusbar-h, 26px);
    z-index: 900;
    display: none;
    align-items: center;
    gap: 2px;
    box-sizing: border-box;
    padding: 0 6px;
    background: var(--theme-bg-more-2, #2b2b2b);
    color: var(--theme-fg, #ccc);
    font-size: 12px;
    line-height: 1;
    white-space: nowrap;
    overflow: hidden;
    user-select: none;
    cursor: default;
}
#tabby-mux-statusbar.visible { display: flex; }
#tabby-mux-statusbar .mux-session-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    border-radius: 3px;
    cursor: pointer;
}
#tabby-mux-statusbar .mux-session-chip i { font-size: 11px; opacity: .8; }
#tabby-mux-statusbar .mux-session-chip:hover { background: var(--theme-bg-less, rgba(128,128,128,.25)); }
#tabby-mux-statusbar .mux-session-chip.attached {
    font-weight: 600;
    background: var(--theme-primary, #0d6efd);
    color: var(--theme-primary-fg, #fff);
}
#tabby-mux-statusbar .mux-session-chip.detached { color: var(--theme-fg-more, #999); }
#tabby-mux-statusbar .mux-sep {
    margin: 0 6px 0 4px;
    color: var(--theme-fg-more-2, #666);
}
#tabby-mux-statusbar .mux-window {
    display: inline-flex;
    align-items: center;
    padding: 3px 8px;
    border-radius: 3px;
    cursor: pointer;
}
#tabby-mux-statusbar .mux-window:hover { background: var(--theme-bg-less, rgba(128,128,128,.25)); }
#tabby-mux-statusbar .mux-window.active {
    background: var(--theme-primary, #0d6efd);
    color: var(--theme-primary-fg, #fff);
}
#tabby-mux-statusbar .mux-window.last:not(.active) { color: var(--theme-fg-more, #999); }
#tabby-mux-statusbar .mux-spacer { flex: 1; }
#tabby-mux-statusbar .mux-info {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--theme-fg-more, #999);
    padding: 3px 2px;
}
#tabby-mux-statusbar .mux-info .mux-zoomed { color: var(--theme-warning, #f0ad4e); }
/* Make room for the bar by shrinking the app root (xterm refits via its
   ResizeObserver); the bar itself overlays the freed strip. */
body.mux-statusbar-visible app-root { padding-bottom: var(--mux-statusbar-h, 26px); }
`

/**
 * tmux-style bottom status bar:
 *   [s0*] [s1] [s2] | 0:win 1:win* 2:win- ... pane i/n
 *
 * Session chips switch attachment (tmux attach semantics); the window list
 * always shows the bar session's windows. Tabby has no status bar extension
 * point, so the bar is injected as a fixed overlay on document.body
 * (TerminalWorkwench's host-injection pattern).
 */
@Injectable({ providedIn: 'root' })
export class MuxStatusbarService {
    private readonly mux: MuxService
    private readonly app: AppService
    private readonly config: ConfigService
    private readonly i18n: I18n

    private bar: HTMLElement | null = null
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

        this.bar = document.createElement('div')
        this.bar.id = BAR_ID
        document.body.appendChild(this.bar)
        this.bar.addEventListener('click', ev => this.onClick(ev))

        this.mux.changed$.subscribe(() => this.scheduleRender())
        this.app.activeTabChange$.subscribe(() => this.scheduleRender())
        this.config.changed$.subscribe(() => this.scheduleRender())
        this.i18n.localeChanged$.subscribe(() => this.scheduleRender())

        this.scheduleRender()
    }

    private scheduleRender (): void {
        if (this.renderTimer !== null) {
            return
        }
        this.renderTimer = setTimeout(() => {
            this.renderTimer = null
            this.render()
        }, 50)
    }

    private render (): void {
        if (!this.bar) {
            return
        }
        const settings = this.mux.settings
        // In isolation mode the bar tracks the attached session even when a
        // non-mux tab (settings, ...) is active - it is the session dashboard.
        const session = this.mux.isolated ? this.mux.attachedSession : this.mux.activeSession
        const show = settings.statusBar.enabled && !!session

        document.documentElement.style.setProperty(
            '--mux-statusbar-h', `${Math.max(14, settings.statusBar.height)}px`)

        this.bar.classList.toggle('visible', show)
        document.body.classList.toggle('mux-statusbar-visible', show)
        if (!show) {
            return
        }

        this.bar.innerHTML = this.buildHtml(session!)
    }

    private buildHtml (session: MuxSession): string {
        const parts: string[] = []

        // ---- session chips (attach switcher) ----
        for (const s of this.mux.sessions) {
            const isAttached = s === (this.mux.attachedSession ?? session)
            const classes = [
                'mux-session-chip',
                isAttached ? 'attached' : 'detached',
            ].join(' ')
            const label = escapeHtml(s.name) +
                (isAttached || s.windows.length === 1 ? '' : ` (${s.windows.length})`)
            parts.push(
                `<span class="${classes}" data-session-id="${s.id}" ` +
                `title="${escapeHtml(this.i18n.t('mux.statusbar.session', { name: s.name }))}">` +
                `<i class="fas fa-layer-group"></i>${label}</span>`)
        }
        parts.push('<span class="mux-sep">|</span>')

        // ---- window list of the bar session ----
        session.windows.forEach((win, index) => {
            const isCurrent = index === session.currentWindowIndex
            const isLast = index === session.lastWindowIndex
            const classes = [
                'mux-window',
                isCurrent ? 'active' : '',
                isLast ? 'last' : '',
            ].filter(Boolean).join(' ')
            const markers = (isCurrent ? '*' : '') + (isLast && !isCurrent ? '-' : '')
            parts.push(
                `<span class="${classes}" data-window-id="${win.id}" ` +
                `title="${escapeHtml(this.mux.windowTitle(win))}">` +
                `${index}:${escapeHtml(this.mux.windowTitle(win))}${markers}</span>`)
        })

        // ---- pane info (only when a mux window is actually the active tab) ----
        const right: string[] = []
        const activeWindow = this.mux.activeWindow
        if (this.mux.settings.statusBar.showPaneInfo && activeWindow?.session === session) {
            const panes = activeWindow.tab.getAllTabs()
            const focused = activeWindow.tab.getFocusedTab()
            const current = focused ? panes.indexOf(focused) + 1 : 0
            const info = this.i18n.t('mux.statusbar.pane', { cur: current, n: panes.length })
            const zoomed = activeWindow.tab.getMaximizedTab()
                ? `<span class="mux-zoomed">${escapeHtml(this.i18n.t('mux.statusbar.zoomed'))}</span>`
                : ''
            right.push(`<span class="mux-info">${escapeHtml(info)}${zoomed}</span>`)
        }

        parts.push('<span class="mux-spacer"></span>', ...right)
        return parts.join('')
    }

    private onClick (ev: MouseEvent): void {
        const target = ev.target as HTMLElement | null
        if (!target) {
            return
        }
        const sessionEl = target.closest('.mux-session-chip') as HTMLElement | null
        if (sessionEl) {
            const id = sessionEl.dataset['sessionId']
            const session = this.mux.sessions.find(s => s.id === id)
            if (session) {
                this.mux.switchToSession(session)
            }
            return
        }
        const windowEl = target.closest('.mux-window') as HTMLElement | null
        if (windowEl) {
            const id = windowEl.dataset['windowId']
            const win = this.mux.sessions.flatMap(s => s.windows).find(w => w.id === id)
            if (win) {
                this.mux.selectWindow(win)
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
