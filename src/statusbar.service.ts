import { Injectable, Injector, NgZone } from '@angular/core'
import { cpus, freemem, totalmem } from 'os'
import { AppService, ConfigService } from 'tabby-core'
import { MuxService } from './mux.service'
import { I18n } from './i18n'

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
#tabby-mux-statusbar .mux-sessions {
    display: flex;
    gap: 2px;
    min-width: 0;
    overflow: hidden;
    flex: 0 1 auto;
}
#tabby-mux-statusbar .mux-session-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    border-radius: 3px;
    cursor: pointer;
    min-width: 0;
    overflow: hidden;
}
#tabby-mux-statusbar .mux-chip-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
#tabby-mux-statusbar .mux-session-chip i { font-size: 11px; opacity: .8; }
#tabby-mux-statusbar .mux-chip-index {
    font-variant-numeric: tabular-nums;
    font-size: 11px;
    opacity: .75;
}
#tabby-mux-statusbar .mux-session-chip:hover { background: var(--theme-bg-less, rgba(128,128,128,.25)); }
#tabby-mux-statusbar .mux-session-chip.attached {
    font-weight: 600;
    background: var(--theme-primary, #0d6efd);
    color: var(--theme-primary-fg, #fff);
}
#tabby-mux-statusbar .mux-session-chip.detached { color: var(--theme-fg-more, #999); }
#tabby-mux-statusbar .mux-spacer { flex: 1 1 auto; min-width: 8px; }
#tabby-mux-statusbar .mux-info {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    color: var(--theme-fg-more, #999);
    padding: 3px 2px;
    flex-shrink: 0;
}
#tabby-mux-statusbar .mux-info .mux-zoomed { color: var(--theme-warning, #f0ad4e); }
#tabby-mux-statusbar .mux-info .mux-stat { display: inline-flex; align-items: center; gap: 4px; }
#tabby-mux-statusbar .mux-info .mux-stat i { font-size: 11px; }
#tabby-mux-statusbar .mux-info .mux-stat.warn { color: var(--theme-warning, #f0ad4e); }
#tabby-mux-statusbar .mux-tmpl-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    border-radius: 3px;
    color: var(--theme-fg-more, #999);
    cursor: pointer;
    flex-shrink: 0;
}
#tabby-mux-statusbar .mux-tmpl-btn:hover { background: var(--theme-bg-less, rgba(128,128,128,.25)); }
#tabby-mux-statusbar .mux-tmpl-btn i { font-size: 11px; }
/* Make room for the bar by shrinking the app root (xterm refits via its
   ResizeObserver); the bar itself overlays the freed strip. */
body.mux-statusbar-visible app-root { padding-bottom: var(--mux-statusbar-h, 26px); }
`

/**
 * tmux-style bottom status bar - the session dashboard:
 *   [s0*] [s1] | pane i/n | CPU 12% MEM 45%
 *
 * The window list intentionally lives in the tab bar, not here. Tabby has no
 * status bar extension point, so the bar is injected as a fixed overlay on
 * document.body (TerminalWorkwench's host-injection pattern).
 */
@Injectable({ providedIn: 'root' })
export class MuxStatusbarService {
    private readonly mux: MuxService
    private readonly app: AppService
    private readonly config: ConfigService
    private readonly i18n: I18n
    private readonly zone: NgZone

    private bar: HTMLElement | null = null
    private started = false
    private renderTimer: any = null

    private samplerTimer: any = null
    private lastCpuSample: ReturnType<typeof cpus> | null = null
    private cpuUsage = 0
    private memUsage = 0

    constructor (injector: Injector) {
        this.mux = injector.get(MuxService)
        this.app = injector.get(AppService)
        this.config = injector.get(ConfigService)
        this.i18n = injector.get(I18n)
        this.zone = injector.get(NgZone)
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
        this.bar.addEventListener('contextmenu', ev => this.onContextMenu(ev))

        this.mux.changed$.subscribe(() => this.scheduleRender())
        this.app.activeTabChange$.subscribe(() => this.scheduleRender())
        this.config.changed$.subscribe(() => {
            this.applySamplerSetting()
            this.scheduleRender()
        })
        this.i18n.localeChanged$.subscribe(() => this.scheduleRender())

        this.applySamplerSetting()
        this.scheduleRender()
    }

    /**
     * (Re)starts the system resource sampler. Runs outside the Angular zone:
     * rendering is plain DOM, so the ticks must not wake change detection.
     */
    private applySamplerSetting (): void {
        const wanted = this.mux.settings.statusBar
        const needsSampler = wanted.enabled && (wanted.showCpu || wanted.showMem)
        const interval = Math.max(500, wanted.resourceIntervalMs)

        if (this.samplerTimer !== null) {
            clearInterval(this.samplerTimer)
            this.samplerTimer = null
            this.lastCpuSample = null
        }
        if (!needsSampler) {
            return
        }
        this.zone.runOutsideAngular(() => {
            this.samplerTimer = setInterval(() => this.sampleResources(), interval)
        })
    }

    private sampleResources (): void {
        const wanted = this.mux.settings.statusBar
        let changed = false
        if (wanted.showCpu) {
            const now = cpus()
            if (this.lastCpuSample) {
                let idle = 0
                let total = 0
                for (let i = 0; i < now.length && i < this.lastCpuSample.length; i++) {
                    const t = now[i].times
                    const l = this.lastCpuSample[i].times
                    const busy = (t.user - l.user) + (t.nice - l.nice) +
                        (t.sys - l.sys) + (t.irq - l.irq)
                    idle += t.idle - l.idle
                    total += busy + (t.idle - l.idle)
                }
                if (total > 0) {
                    this.cpuUsage = Math.max(0, Math.min(100, Math.round(100 * (1 - idle / total))))
                    changed = true
                }
            }
            this.lastCpuSample = now
        }
        if (wanted.showMem) {
            const used = 1 - freemem() / totalmem()
            this.memUsage = Math.max(0, Math.min(100, Math.round(used * 100)))
            changed = true
        }
        if (changed) {
            this.scheduleRender()
        }
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

    private buildHtml (session: any): string {
        const parts: string[] = []

        // ---- session chips (attach switcher), in a shrinkable container
        // so long/many names compress instead of pushing the right side out
        const showIndex = this.mux.settings.showSessionIndex
        const chips: string[] = []
        this.mux.sessions.forEach((s, index) => {
            const isAttached = s === (this.mux.attachedSession ?? session)
            const classes = [
                'mux-session-chip',
                isAttached ? 'attached' : 'detached',
            ].join(' ')
            const display = this.mux.sessionDisplayName(s)
            const indexEl = showIndex
                ? `<span class="mux-chip-index">${index}</span>`
                : ''
            const label = escapeHtml(display) +
                (isAttached || s.windows.length === 1 ? '' : ` (${s.windows.length})`)
            chips.push(
                `<span class="${classes}" data-session-id="${s.id}" ` +
                `title="${escapeHtml(this.i18n.t('mux.statusbar.session', { name: display }))}">` +
                `<i class="fas fa-layer-group"></i>${indexEl}` +
                `<span class="mux-chip-label">${label}</span></span>`)
        })
        parts.push(`<span class="mux-sessions">${chips.join('')}</span>`)

        // ---- right side: pane info + system resources ----
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
            right.push(`<span class="mux-stat">${escapeHtml(info)}${zoomed}</span>`)
        }
        if (this.mux.settings.statusBar.showCpu) {
            right.push(this.statSegment('fa-microchip', 'CPU', this.cpuUsage, '%'))
        }
        if (this.mux.settings.statusBar.showMem) {
            right.push(this.statSegment('fa-memory', 'MEM', this.memUsage, '%'))
        }
        if (right.length) {
            parts.push('<span class="mux-spacer"></span>', `<span class="mux-info">${right.join('')}</span>`)
        }
        // Template entry - always visible: with templates it opens the
        // searchable selector, without any it offers saving the current
        // session (so the feature is discoverable from the very start).
        const tmplCount = this.mux.templates.length
        const tmplTitle = tmplCount ? this.i18n.t('mux.tmpl.browse') : this.i18n.t('mux.settings.tplSave')
        parts.push(
            `<span class="mux-tmpl-btn" title="${escapeHtml(tmplTitle)}">` +
            `<i class="fas fa-bookmark"></i>${tmplCount ? tmplCount : '+'}</span>`)
        return parts.join('')
    }

    private statSegment (icon: string, label: string, value: number, suffix: string): string {
        const warn = value >= 80 ? ' warn' : ''
        return `<span class="mux-stat${warn}"><i class="fas ${icon}"></i>` +
            `${label} ${value}${suffix}</span>`
    }

    private onClick (ev: MouseEvent): void {
        const target = ev.target as HTMLElement | null
        if (!target) {
            return
        }
        if (target.closest('.mux-tmpl-btn')) {
            if (this.mux.templates.length) {
                void this.mux.browseTemplates()
            } else {
                void this.mux.saveSessionAsTemplatePrompt(this.mux.activeSession)
            }
            return
        }
        const sessionEl = target.closest('.mux-session-chip') as HTMLElement | null
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
        const sessionEl = target.closest('.mux-session-chip') as HTMLElement | null
        if (sessionEl) {
            const id = sessionEl.dataset['sessionId']
            const session = this.mux.sessions.find(s => s.id === id)
            if (session) {
                ev.preventDefault()
                this.mux.sessionContextMenu(session, ev)
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
