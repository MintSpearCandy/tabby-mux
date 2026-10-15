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
#tabby-mux-rail .mux-rail-header .mux-rail-count {
    margin-left: auto;
    font-weight: 400;
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
#tabby-mux-rail .mux-rail-session.attached .mux-rail-count { color: inherit; opacity: .8; }
#tabby-mux-rail .mux-rail-session i { font-size: 11px; opacity: .8; flex-shrink: 0; }
#tabby-mux-rail .mux-rail-name { overflow: hidden; text-overflow: ellipsis; }
#tabby-mux-rail .mux-rail-count {
    margin-left: auto;
    color: var(--theme-fg-more, #999);
    font-size: 11px;
    flex-shrink: 0;
}
#tabby-mux-rail .mux-rail-templates {
    display: flex;
    flex-direction: column;
    max-height: 40%;
    flex-shrink: 0;
    border-top: 1px solid var(--theme-bg-less, rgba(128,128,128,.2));
}
#tabby-mux-rail.no-templates .mux-rail-search { display: none; }
#tabby-mux-rail .mux-rail-search {
    margin: 2px 8px 4px;
    padding: 3px 8px;
    border: none;
    border-radius: 4px;
    background: var(--theme-bg-less, rgba(128,128,128,.2));
    color: var(--theme-fg, #ccc);
    font-size: 12px;
}
#tabby-mux-rail .mux-rail-search::placeholder { color: var(--theme-fg-more-2, #666); }
#tabby-mux-rail .mux-rail-search:focus { outline: 1px solid var(--theme-primary, #0d6efd); }
#tabby-mux-rail .mux-rail-template-list {
    flex: 1;
    overflow-y: auto;
    padding: 0 4px 4px;
}
#tabby-mux-rail .mux-rail-template {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    margin: 1px 0;
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    color: var(--theme-fg-more, #999);
}
#tabby-mux-rail .mux-rail-template:hover { background: var(--theme-bg-less, rgba(128,128,128,.25)); color: var(--theme-fg, #ccc); }
#tabby-mux-rail .mux-rail-template i { font-size: 11px; opacity: .8; flex-shrink: 0; }
#tabby-mux-rail .mux-rail-template .mux-rail-name { overflow: hidden; text-overflow: ellipsis; }
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
    flex-shrink: 0;
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
 *
 * The rail shell (headers, search input, buttons) is built once so the
 * search box keeps focus; render() only rewrites the session and template
 * list containers. Right-clicking a session offers save-as-template (and
 * rename/kill); right-clicking a template offers apply/delete.
 */
@Injectable({ providedIn: 'root' })
export class MuxSidebarService {
    private readonly mux: MuxService
    private readonly app: AppService
    private readonly config: ConfigService
    private readonly i18n: I18n

    private rail: HTMLElement | null = null
    private sessionsEl: HTMLElement | null = null
    private templatesEl: HTMLElement | null = null
    private searchInput: HTMLInputElement | null = null
    private searchText = ''
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
        // Static shell: rebuilt only here, never during render() - the search
        // input must survive re-renders to keep focus while typing.
        this.rail.innerHTML =
            `<div class="mux-rail-header"><i class="fas fa-layer-group"></i>` +
            `${escapeHtml(this.i18n.t('mux.rail.header'))}</div>` +
            `<div class="mux-rail-sessions"></div>` +
            `<div class="mux-rail-templates">` +
            `<div class="mux-rail-header"><i class="fas fa-bookmark"></i>` +
            `${escapeHtml(this.i18n.t('mux.tmpl.section'))}` +
            `<span class="mux-rail-count mux-tpl-count"></span></div>` +
            `<input class="mux-rail-search" type="text" ` +
            `placeholder="${escapeHtml(this.i18n.t('mux.tmpl.search'))}">` +
            `<div class="mux-rail-template-list"></div>` +
            `</div>` +
            `<button class="mux-rail-new">` +
            `<i class="fas fa-plus"></i>${escapeHtml(this.i18n.t('mux.rail.newSession'))}</button>`

        // First child = leftmost slot, before the profile tree / any sidebars.
        host.insertBefore(this.rail, host.firstChild)

        this.sessionsEl = this.rail.querySelector('.mux-rail-sessions')
        this.templatesEl = this.rail.querySelector('.mux-rail-template-list')
        this.searchInput = this.rail.querySelector('.mux-rail-search')

        this.rail.addEventListener('click', ev => this.onClick(ev))
        this.rail.addEventListener('contextmenu', ev => this.onContextMenu(ev))
        this.searchInput?.addEventListener('input', () => {
            this.searchText = this.searchInput?.value ?? ''
            this.renderTemplates()
        })

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
        const settings = this.mux.settings.sidebar
        const show = settings.enabled && this.mux.sessions.length > 0

        document.documentElement.style.setProperty(
            '--mux-rail-w', `${Math.max(80, settings.width)}px`)
        this.rail.classList.toggle('visible', show)
        if (!show) {
            return
        }

        this.renderSessions()
        this.renderTemplates()
    }

    private renderSessions (): void {
        if (!this.sessionsEl) {
            return
        }
        const attached = this.mux.attachedSession
        const parts: string[] = []
        for (const s of this.mux.sessions) {
            const isAttached = s === attached
            parts.push(
                `<div class="mux-rail-session ${isAttached ? 'attached' : ''}" ` +
                `data-session-id="${s.id}" title="${escapeHtml(s.name)}">` +
                `<i class="fas ${isAttached ? 'fa-circle' : 'fa-circle-thin'}"></i>` +
                `<span class="mux-rail-name">${escapeHtml(s.name)}</span>` +
                `<span class="mux-rail-count">${s.windows.length}</span></div>`)
        }
        this.sessionsEl.innerHTML = parts.join('')
    }

    private renderTemplates (): void {
        if (!this.rail || !this.templatesEl) {
            return
        }
        const templates = this.mux.templates
        this.rail.classList.toggle('no-templates', templates.length === 0)

        const countEl = this.rail.querySelector('.mux-tpl-count')
        if (countEl) {
            countEl.textContent = templates.length ? `${templates.length}` : ''
        }

        // Empty state doubles as the save entry, so the template area is
        // always discoverable even before the first template exists.
        if (!templates.length) {
            this.templatesEl.innerHTML =
                `<div class="mux-rail-template mux-rail-save-entry" ` +
                `title="${escapeHtml(this.i18n.t('mux.settings.tplSave'))}">` +
                `<i class="fas fa-plus"></i>` +
                `<span class="mux-rail-name">${escapeHtml(this.i18n.t('mux.settings.tplSave'))}</span></div>`
            return
        }

        const needle = this.searchText.trim().toLowerCase()
        const filtered = needle
            ? templates.filter(t => t.name.toLowerCase().includes(needle))
            : templates
        if (!filtered.length) {
            this.templatesEl.innerHTML =
                `<div class="mux-rail-template" style="cursor:default;opacity:.6">` +
                `${escapeHtml(this.i18n.t('mux.tmpl.none'))}</div>`
            return
        }
        const parts: string[] = []
        for (const t of filtered) {
            parts.push(
                `<div class="mux-rail-template" data-template-id="${t.id}" ` +
                `title="${escapeHtml(this.i18n.t('mux.tmpl.apply'))}">` +
                `<i class="fas fa-bookmark"></i>` +
                `<span class="mux-rail-name">${escapeHtml(t.name)}</span></div>`)
        }
        this.templatesEl.innerHTML = parts.join('')
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
        if (target.closest('.mux-rail-save-entry')) {
            void this.mux.saveSessionAsTemplatePrompt(this.mux.activeSession)
            return
        }
        const templateEl = target.closest('.mux-rail-template') as HTMLElement | null
        if (templateEl?.dataset['templateId']) {
            const template = this.mux.templates.find(t => t.id === templateEl.dataset['templateId'])
            if (template) {
                void this.mux.createSessionFromTemplate(template)
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
        const templateEl = target.closest('.mux-rail-template') as HTMLElement | null
        if (templateEl?.dataset['templateId']) {
            const template = this.mux.templates.find(t => t.id === templateEl.dataset['templateId'])
            if (template) {
                ev.preventDefault()
                this.mux.templateContextMenu(template, ev)
            }
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
}

function escapeHtml (text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}
