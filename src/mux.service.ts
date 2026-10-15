import { Injectable, Injector } from '@angular/core'
import { Subject, Subscription } from 'rxjs'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import {
    AppService,
    BaseTabComponent,
    ConfigService,
    HotkeysService,
    MenuItemOptions,
    PlatformService,
    ProfilesService,
    PromptModalComponent,
    SelectorService,
    SplitTabComponent,
    TabRecoveryService,
    TabsService,
} from 'tabby-core'
import { CONFIG_KEY, DEBUG_HANDLE } from './configKeys'
import { MUX_COMMANDS } from './commands'
import { I18n } from './i18n'
import { defaultMuxSettings, MuxSession, MuxSessionTemplate, MuxSettings, MuxWindow } from './types'
import { MuxStatusbarService } from './statusbar.service'
import { MuxSidebarService } from './sidebar.service'

/**
 * Owns the tmux session/window hierarchy.
 *
 * Mapping (v1.0.237 facts, see CLAUDE.md):
 *   session -> MuxSession (plugin-side runtime state)
 *   window  -> one top-level SplitTabComponent (every terminal tab is wrapped
 *              in one by AppService.openNewTab / wrapAndAddTab)
 *   pane    -> child tabs of that SplitTab; NOT wrapped plugin-side - the
 *              native split engine stays the single source of truth.
 */
@Injectable({ providedIn: 'root' })
export class MuxService {
    sessions: MuxSession[] = []

    /** Structure or title changed (window added/removed/renamed, ...). */
    readonly changed$ = new Subject<void>()

    private readonly app: AppService
    private readonly tabsService: TabsService
    private readonly profiles: ProfilesService
    private readonly config: ConfigService
    private readonly tabRecovery: TabRecoveryService
    private readonly platform: PlatformService
    private readonly injector: Injector
    private readonly i18n: I18n

    private readonly windowByTab = new Map<BaseTabComponent, MuxWindow>()
    private readonly titleSubs = new Map<BaseTabComponent, Subscription>()
    private sessionSeq = 0
    private windowSeq = 0
    private suppressAdoption = 0
    private booted = false

    constructor (injector: Injector) {
        this.injector = injector
        this.app = injector.get(AppService)
        this.tabsService = injector.get(TabsService)
        this.profiles = injector.get(ProfilesService)
        this.config = injector.get(ConfigService)
        this.tabRecovery = injector.get(TabRecoveryService)
        this.platform = injector.get(PlatformService)
        this.i18n = injector.get(I18n)

        // Debug handle for CDP-based verification of a running instance.
        // (assigned via a local because a leading-paren line would chain onto
        // the previous call through ASI)
        const w = window as any
        w[DEBUG_HANDLE] = this

        this.config.ready$.subscribe(ready => {
            if (ready) {
                this.boot()
            }
        })

        // Never resolve HotkeysService synchronously from a constructor that
        // can sit inside a Hotkey/ToolbarButton provider chain - that is a DI
        // creation cycle which silently kills the whole plugin.
        queueMicrotask(() => {
            this.injector.get(HotkeysService).hotkey$.subscribe(id => {
                void this.runCommand(id)
            })
        })
    }

    // ==================================================================
    // Queries
    // ==================================================================

    get settings (): MuxSettings {
        return this.config.store?.[CONFIG_KEY] ?? defaultMuxSettings()
    }

    get isolated (): boolean {
        return this.settings.isolatedSessions
    }

    /**
     * The session whose windows are currently attached (listed in the tab
     * bar). Only meaningful in isolation mode; in mixed mode it tracks the
     * session of the active tab as a switching baseline.
     */
    get attachedSession (): MuxSession | null {
        return this.sessions.find(s => s.id === this.attachedSessionId) ?? null
    }

    /**
     * Session commands operate on. In isolation mode this is the attached
     * session (even when a non-mux tab like settings is active); in mixed
     * mode it derives from the active tab.
     */
    get activeSession (): MuxSession | null {
        if (this.isolated) {
            return this.attachedSession
        }
        return this.activeWindow?.session ?? null
    }

    private attachedSessionId: string | null = null

    get activeWindow (): MuxWindow | null {
        const tab = this.app.activeTab
        if (tab instanceof SplitTabComponent) {
            return this.windowByTab.get(tab) ?? null
        }
        return null
    }

    windowForTab (tab: BaseTabComponent): MuxWindow | null {
        return this.windowByTab.get(tab) ?? null
    }

    /** Display name: custom window name, else the tab's dynamic title. */
    windowTitle (win: MuxWindow): string {
        return win.name ?? win.tab.title ?? ''
    }

    // ==================================================================
    // Session operations
    // ==================================================================

    newSession (name?: string | null): MuxSession {
        const finalName = this.uniqueSessionName(name ?? this.settings.defaultSessionName)
        const session: MuxSession = {
            id: `s${this.sessionSeq++}`,
            name: finalName,
            createdAt: Date.now(),
            windows: [],
            currentWindowIndex: -1,
            lastWindowIndex: -1,
        }
        this.sessions.push(session)
        this.changed$.next()
        return session
    }

    private uniqueSessionName (requested: string | null): string {
        if (requested) {
            return requested
        }
        let name = `${this.sessionSeq}`
        while (this.sessions.some(s => s.name === name)) {
            name = `${++this.sessionSeq}`
        }
        return name
    }

    async createSessionWithWindow (name?: string | null): Promise<MuxSession> {
        // tmux `new-session`: detach the currently attached session first so
        // the new session's window opens into an isolated tab bar.
        if (this.isolated && this.attachedSession) {
            this.detachSession(this.attachedSession)
        }
        const session = this.newSession(name)
        await this.newWindow(session)
        return session
    }

    renameSession (session: MuxSession, name: string): void {
        const trimmed = name.trim()
        if (!trimmed) {
            return
        }
        session.name = trimmed
        this.changed$.next()
    }

    async renameSessionPrompt (session: MuxSession | null): Promise<void> {
        if (!session) {
            return
        }
        const result = await this.promptText('mux.sessionPrompt', session.name)
        if (result !== null) {
            this.renameSession(session, result)
        }
    }

    async killSession (session: MuxSession | null): Promise<void> {
        if (!session) {
            return
        }
        for (const win of [...session.windows]) {
            await this.killWindow(win)
        }
    }

    // ==================================================================
    // Session attachment (tmux-style tab bar isolation)
    // ==================================================================

    /**
     * Soft-removes every window of the session from the tab bar. Components
     * and terminal sessions stay alive: app.removeTab does not destroy tabs,
     * and the destroyed tab-body only detaches the host view
     * (tabBody.component.ts ngOnDestroy -> placeholder.detach()).
     * tabRemoved$ is NOT emitted by this path (it only fires on destroy), so
     * the plugin registry stays untouched.
     */
    private detachSession (session: MuxSession): void {
        if (session.id !== this.attachedSessionId) {
            return
        }
        for (const win of [...session.windows]) {
            const index = this.app.tabs.indexOf(win.tab)
            if (index !== -1) {
                this.app.removeTab(win.tab)
            }
        }
        this.attachedSessionId = null
        this.changed$.next()
    }

    /**
     * Attaches a session: detaches the currently attached one (if any) and
     * re-lists the target session's windows. addTabRaw re-creates a tab-body
     * per window whose ngOnChanges re-inserts the preserved host view, so the
     * terminal renders again and its ResizeObserver refits the PTY.
     */
    attachSession (session: MuxSession): void {
        const current = this.attachedSession
        if (current === session) {
            return
        }
        if (current) {
            this.detachSession(current)
        }
        for (const win of session.windows) {
            if (!this.app.tabs.includes(win.tab)) {
                this.app.addTabRaw(win.tab)
            }
        }
        this.attachedSessionId = session.id
        const win = session.windows[Math.max(0, session.currentWindowIndex)]
        if (win) {
            this.app.selectTab(win.tab)
        }
        this.changed$.next()
    }

    /** Mode-aware session switch (status bar chips, switch-session commands). */
    switchToSession (session: MuxSession): void {
        if (this.isolated) {
            this.attachSession(session)
            return
        }
        const win = session.windows[Math.max(0, session.currentWindowIndex)]
        if (win) {
            this.app.selectTab(win.tab)
        }
    }

    /**
     * Reconciles the tab bar with the current isolation setting. Idempotent;
     * runs on boot and on every config change.
     */
    private applyIsolationSetting (): void {
        if (this.isolated) {
            const keep = this.activeWindow?.session ?? this.attachedSession ?? this.sessions[0]
            if (!keep) {
                return
            }
            // Un-list every other session's windows. Beyond detaching the
            // previously attached session this also covers the
            // mixed -> isolated transition, where several sessions' tabs are
            // in the bar at once.
            for (const session of this.sessions) {
                if (session === keep) {
                    continue
                }
                for (const win of session.windows) {
                    const index = this.app.tabs.indexOf(win.tab)
                    if (index !== -1) {
                        this.app.removeTab(win.tab)
                    }
                }
            }
            if (this.attachedSessionId && this.attachedSessionId !== keep.id) {
                this.attachedSessionId = null
            }
            this.attachSession(keep)
            this.changed$.next()
        } else {
            // Mixed mode: every session's windows are listed.
            for (const session of this.sessions) {
                for (const win of session.windows) {
                    if (!this.app.tabs.includes(win.tab)) {
                        this.app.addTabRaw(win.tab)
                    }
                }
            }
        }
    }

    switchSession (delta: number): void {
        if (!this.sessions.length) {
            return
        }
        const current = this.sessions.indexOf(this.attachedSession ?? this.activeSession ?? this.sessions[0])
        const target = (current + delta + this.sessions.length) % this.sessions.length
        this.switchToSession(this.sessions[target])
    }

    // ==================================================================
    // Window operations
    // ==================================================================

    /**
     * Opens a new top-level terminal tab and registers it as a window of the
     * session. Mirrors tmux `new-window`.
     */
    async newWindow (session?: MuxSession, profile?: any): Promise<MuxWindow | null> {
        const targetSession = session ?? this.activeSession ?? this.newSession()
        if (this.isolated && this.attachedSession !== targetSession) {
            // Bring the target session into view first so the new window
            // lands inside an isolated tab bar.
            this.attachSession(targetSession)
        }
        const resolved = profile ?? await this.resolveProfile(targetSession)
        if (!resolved) {
            return null
        }
        const params = await this.profiles.newTabParametersForProfile(resolved)
        if (!params) {
            return null
        }
        this.suppressAdoption++
        try {
            const inner = this.tabsService.create(params)
            // wrapAndAddTab wraps + selects + returns the wrapper (the window);
            // openNewTab() would only return the inner tab.
            const split = this.app.wrapAndAddTab(inner)
            return this.registerWindow(targetSession, split)
        } finally {
            this.suppressAdoption--
        }
    }

    async killWindow (win: MuxWindow | null): Promise<void> {
        if (!win) {
            return
        }
        if (this.app.tabs.includes(win.tab)) {
            await this.app.closeTab(win.tab)
        } else {
            // Detached window: closeTab only works on listed tabs. Destroying
            // directly still fires tabRemoved$ (via addTabRaw's destroyed$
            // subscription), so the registry prunes itself.
            if (await win.tab.canClose()) {
                win.tab.destroy()
            }
        }
    }

    selectWindow (win: MuxWindow): void {
        this.app.selectTab(win.tab)
    }

    selectWindowIndex (session: MuxSession | null, index: number): void {
        if (!session || index < 0 || index >= session.windows.length) {
            return
        }
        this.selectWindow(session.windows[index])
    }

    /** tmux `next-window` / `previous-window`. */
    stepWindow (delta: number): void {
        const session = this.activeSession
        if (!session || !session.windows.length) {
            return
        }
        const current = Math.max(0, session.currentWindowIndex)
        const target = (current + delta + session.windows.length) % session.windows.length
        this.selectWindow(session.windows[target])
    }

    renameWindow (win: MuxWindow, name: string): void {
        const trimmed = name.trim()
        win.name = trimmed || null
        // Keep the native tab bar in sync (empty custom title = dynamic again).
        // setCustomTitle exists at runtime (host >= 1.0.237) but is missing
        // from the tabby-core@1.0.231-nightly typings.
        ;(win.tab as any).setCustomTitle(trimmed)
        this.changed$.next()
    }

    async renameWindowPrompt (win: MuxWindow | null): Promise<void> {
        if (!win) {
            return
        }
        const result = await this.promptText('mux.windowPrompt', this.windowTitle(win))
        if (result !== null) {
            this.renameWindow(win, result)
        }
    }

    // ==================================================================
    // Pane operations (delegated to the native split engine)
    // ==================================================================

    /** `orientation`: 'h' = side by side (tmux %), 'v' = stacked (tmux "). */
    async splitPane (orientation: 'h' | 'v'): Promise<BaseTabComponent | null> {
        const split = this.requireActiveSplit()
        if (!split) {
            return null
        }
        // The focused pane appears asynchronously after a window is created
        // (wrapAndAddTab does not await the internal addTab, and focus is set
        // in onAfterTabAdded) - wait briefly instead of no-op'ing.
        let focused = split.getFocusedTab()
        for (let i = 0; !focused && i < 15; i++) {
            await new Promise(resolve => setTimeout(resolve, 200))
            focused = split.getFocusedTab()
        }
        if (!focused) {
            return null
        }
        const side: 'r' | 'b' = orientation === 'h' ? 'r' : 'b'
        // Native split duplicates the focused pane; duplication needs its
        // recovery token, which a freshly created terminal provides only after
        // session init (returns null until then). Fall back to creating a
        // fresh pane from the same profile - closer to tmux anyway, where the
        // new pane runs a new shell.
        const pane = await split.splitTab(focused, side)
        if (pane) {
            return pane
        }
        const profile = (focused as any).profile
        if (!profile) {
            return null
        }
        const params = await this.profiles.newTabParametersForProfile(profile)
        if (!params) {
            return null
        }
        const newPane = this.tabsService.create(params)
        await split.addTab(newPane, focused, side)
        return newPane
    }

    async killPane (): Promise<void> {
        const split = this.requireActiveSplit()
        const pane = split?.getFocusedTab()
        if (!pane) {
            return
        }
        if (await pane.canClose()) {
            pane.destroy()
        }
    }

    stepPane (delta: number): void {
        this.requireActiveSplit()?.navigateLinear(delta)
    }

    navigatePane (dir: 'l' | 'r' | 't' | 'b'): void {
        this.requireActiveSplit()?.navigate(dir)
    }

    togglePaneZoom (): void {
        const split = this.requireActiveSplit()
        if (!split) {
            return
        }
        split.maximize(split.getMaximizedTab() ? null : split.getFocusedTab())
    }

    equalizePanes (): void {
        this.requireActiveSplit()?.equalize()
    }

    resizePane (direction: 'v' | 'h' | 'dv' | 'dh'): void {
        this.requireActiveSplit()?.resizePane(direction)
    }

    // ==================================================================
    // Misc
    // ==================================================================

    async toggleStatusbar (): Promise<void> {
        const bar = this.settings.statusBar
        this.config.store[CONFIG_KEY].statusBar.enabled = !bar.enabled
        await this.config.save()
    }

    async toggleIsolation (): Promise<void> {
        this.config.store[CONFIG_KEY].isolatedSessions = !this.settings.isolatedSessions
        await this.config.save()
        // applyIsolationSetting runs via config.changed$.
    }

    async toggleSidebar (): Promise<void> {
        const sidebar = this.settings.sidebar
        this.config.store[CONFIG_KEY].sidebar.enabled = !sidebar.enabled
        await this.config.save()
    }

    /** Central dispatcher shared by hotkeys and the palette. */
    async runCommand (id: string): Promise<void> {
        const spec = MUX_COMMANDS.find(c => c.id === id)
        if (!spec) {
            return
        }
        if (spec.needsSession && !this.sessions.length) {
            return
        }
        if (spec.needsWindow && !this.activeWindow) {
            return
        }
        await spec.run(this)
    }

    // ==================================================================
    // Session templates
    // ==================================================================

    get templates (): MuxSessionTemplate[] {
        return this.settings.templates ?? []
    }

    /**
     * Captures a session's workspace (window layouts + terminal profiles)
     * via each window's recovery token. Persisted through whole-array
     * assignment - the ConfigProxy drops mutations made via push() on
     * proxied arrays (workwench-documented pitfall).
     */
    async saveSessionAsTemplate (session: MuxSession | null, name: string): Promise<MuxSessionTemplate | null> {
        const trimmed = name.trim()
        if (!session || !trimmed || !session.windows.length) {
            return null
        }
        const windows: any[] = []
        for (const win of session.windows) {
            // Recovery tokens of freshly created tabs appear only after
            // session init - retry briefly before giving up on a window.
            let token = await win.tab.getRecoveryToken()
            for (let i = 0; !token && i < 4; i++) {
                await new Promise(resolve => setTimeout(resolve, 300))
                token = await win.tab.getRecoveryToken()
            }
            if (token) {
                windows.push(token)
            }
        }
        if (!windows.length) {
            return null
        }
        const template: MuxSessionTemplate = {
            id: `tpl-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
            name: trimmed,
            createdAt: Date.now(),
            windows,
        }
        this.config.store[CONFIG_KEY].templates = [...this.templates, template]
        await this.config.save()
        this.changed$.next()
        return template
    }

    async saveSessionAsTemplatePrompt (session: MuxSession | null): Promise<MuxSessionTemplate | null> {
        if (!session) {
            return null
        }
        const result = await this.promptText('mux.templatePrompt', session.name)
        if (result === null) {
            return null
        }
        return this.saveSessionAsTemplate(session, result)
    }

    /**
     * Rebuilds a session from a template: fresh shells in the saved layout
     * (recovery restores profiles/cwd, not running processes).
     */
    async createSessionFromTemplate (template: MuxSessionTemplate): Promise<MuxSession | null> {
        if (this.isolated && this.attachedSession) {
            this.detachSession(this.attachedSession)
        }
        const session = this.newSession(template.name)
        this.suppressAdoption++
        try {
            for (const token of template.windows) {
                const params = await this.tabRecovery.recoverTab(token)
                if (!params) {
                    continue
                }
                const tab = this.tabsService.create(params)
                if (!(tab instanceof SplitTabComponent)) {
                    tab.destroy()
                    continue
                }
                if (!this.app.tabs.includes(tab)) {
                    this.app.addTabRaw(tab)
                }
                this.registerWindow(session, tab)
            }
        } finally {
            this.suppressAdoption--
        }
        if (!session.windows.length) {
            this.sessions = this.sessions.filter(s => s !== session)
            this.changed$.next()
            return null
        }
        if (this.isolated) {
            this.attachSession(session)
        }
        this.changed$.next()
        return session
    }

    async deleteTemplate (template: MuxSessionTemplate): Promise<void> {
        this.config.store[CONFIG_KEY].templates = this.templates.filter(t => t !== template)
        await this.config.save()
        this.changed$.next()
    }

    /**
     * Opens the searchable selector modal (the same one the profile picker
     * uses) with every saved template; choosing one creates a session.
     */
    async browseTemplates (): Promise<void> {
        if (!this.templates.length) {
            return
        }
        const selector = this.injector.get(SelectorService)
        const chosen = await selector.show<MuxSessionTemplate>(
            this.i18n.t('mux.tmpl.section'),
            this.templates.map(t => ({
                name: t.name,
                description: this.i18n.t('mux.settings.tplWindows', { n: t.windows.length }) +
                    ` · ${new Date(t.createdAt).toLocaleString()}`,
                icon: 'fas fa-bookmark',
                result: t,
            })))
        if (chosen) {
            await this.createSessionFromTemplate(chosen)
        }
    }

    /** Right-click menu for a session (rail entries, status bar chips). */
    sessionContextMenu (session: MuxSession, event: MouseEvent): void {
        const items: MenuItemOptions[] = [
            {
                label: this.i18n.t('mux.session.saveTemplate'),
                click: () => void this.saveSessionAsTemplatePrompt(session),
            },
            {
                label: this.i18n.t('mux.session.rename'),
                click: () => void this.renameSessionPrompt(session),
            },
            { type: 'separator' },
            {
                label: this.i18n.t('mux.session.kill'),
                click: () => void this.killSession(session),
            },
        ]
        this.platform.popupContextMenu(items, event)
    }

    /** Right-click menu for a template (rail entries). */
    templateContextMenu (template: MuxSessionTemplate, event: MouseEvent): void {
        const items: MenuItemOptions[] = [
            {
                label: this.i18n.t('mux.tmpl.apply'),
                click: () => void this.createSessionFromTemplate(template),
            },
            { type: 'separator' },
            {
                label: this.i18n.t('mux.tmpl.delete'),
                click: () => void this.deleteTemplate(template),
            },
        ]
        this.platform.popupContextMenu(items, event)
    }

    // ==================================================================
    // Internals
    // ==================================================================

    private requireActiveSplit (): SplitTabComponent | null {
        const tab = this.app.activeTab
        return tab instanceof SplitTabComponent ? tab : null
    }

    private async resolveProfile (session: MuxSession): Promise<any | null> {
        const configuredId = this.settings.newWindowProfile
        if (configuredId) {
            const profiles = await this.profiles.getProfiles()
            const found = profiles.find(p => p.id === configuredId)
            if (found) {
                return found
            }
        }
        // Inherit the profile of the session's focused pane (tmux-like).
        const win = session.windows[Math.max(0, session.currentWindowIndex)]
        const paneProfile = (win?.tab.getFocusedTab() as any)?.profile
        if (paneProfile) {
            return paneProfile
        }
        const profiles = await this.profiles.getProfiles()
        return profiles.find(p => p.type === 'local') ?? null
    }

    private registerWindow (session: MuxSession, tab: SplitTabComponent): MuxWindow {
        const win: MuxWindow = {
            id: `w${this.windowSeq++}`,
            name: null,
            tab,
            session,
        }
        session.windows.push(win)
        this.windowByTab.set(tab, win)
        this.titleSubs.set(tab, tab.titleChange$.subscribe(() => this.changed$.next()))
        // addTabRaw selects the new tab BEFORE this registration runs, so the
        // activeTabChange$ event already flew past trackActiveWindow with the
        // tab still unregistered. Sync indices here to avoid a desync where
        // currentWindowIndex points at the previously active window.
        if (this.app.activeTab === tab) {
            if (session.currentWindowIndex >= 0 && session.currentWindowIndex < session.windows.length - 1) {
                session.lastWindowIndex = session.currentWindowIndex
            }
            session.currentWindowIndex = session.windows.length - 1
        } else if (session.currentWindowIndex < 0) {
            session.currentWindowIndex = session.windows.length - 1
        }
        this.changed$.next()
        return win
    }

    private boot (): void {
        if (this.booted) {
            return
        }
        this.booted = true

        // Adopt tabs that already exist (e.g. recovered from a previous run).
        if (this.settings.autoAdoptWindows) {
            for (const tab of [...this.app.tabs]) {
                this.tryAdopt(tab)
            }
        }

        this.app.tabOpened$.subscribe(tab => this.tryAdopt(tab))
        this.app.tabRemoved$.subscribe(tab => this.pruneWindow(tab))
        this.app.activeTabChange$.subscribe(tab => this.trackActiveWindow(tab))
        this.config.changed$.subscribe(() => this.applyIsolationSetting())

        this.applyIsolationSetting()
        this.injector.get(MuxStatusbarService).start()
        this.injector.get(MuxSidebarService).start()

        this.changed$.next()
    }

    private tryAdopt (tab: BaseTabComponent): void {
        if (this.suppressAdoption > 0) {
            return
        }
        // Only top-level SplitTabs are windows; raw tabs (settings, ...) are not.
        if (!(tab instanceof SplitTabComponent) || tab.parent !== null) {
            return
        }
        if (this.windowByTab.has(tab) || !this.settings.autoAdoptWindows) {
            return
        }
        if (this.isolated) {
            // New terminal tabs join the attached session (or found one); the
            // tab is already listed, so no re-attachment is needed.
            let session = this.attachedSession
            if (!session) {
                session = this.newSession()
                this.attachedSessionId = session.id
            }
            this.registerWindow(session, tab)
            return
        }
        const session = this.activeSession ?? this.newSession()
        this.registerWindow(session, tab)
    }

    private pruneWindow (tab: BaseTabComponent): void {
        const win = this.windowByTab.get(tab)
        if (!win) {
            return
        }
        this.windowByTab.delete(tab)
        this.titleSubs.get(tab)?.unsubscribe()
        this.titleSubs.delete(tab)

        const session = win.session
        session.windows = session.windows.filter(w => w !== win)
        if (!session.windows.length) {
            // tmux kills a session when its last window closes; when the
            // attached session dies, the most recently created remaining one
            // takes over the tab bar.
            this.sessions = this.sessions.filter(s => s !== session)
            if (this.attachedSessionId === session.id) {
                this.attachedSessionId = null
                if (this.isolated && this.sessions.length) {
                    this.attachSession(this.sessions[this.sessions.length - 1])
                }
            }
        } else {
            if (session.currentWindowIndex >= session.windows.length) {
                session.currentWindowIndex = session.windows.length - 1
            }
            if (session.lastWindowIndex >= session.windows.length) {
                session.lastWindowIndex = -1
            }
        }
        this.changed$.next()
    }

    private trackActiveWindow (tab: BaseTabComponent | null): void {
        if (!(tab instanceof SplitTabComponent)) {
            return
        }
        const win = this.windowByTab.get(tab)
        if (!win) {
            return
        }
        const session = win.session
        // In mixed mode the attached baseline follows the active tab so that
        // toggling isolation on keeps the current session in view.
        if (!this.isolated) {
            this.attachedSessionId = session.id
        }
        const index = session.windows.indexOf(win)
        if (index === session.currentWindowIndex) {
            return
        }
        if (session.currentWindowIndex >= 0 && session.currentWindowIndex < session.windows.length) {
            session.lastWindowIndex = session.currentWindowIndex
        }
        session.currentWindowIndex = index
    }

    private async promptText (promptKey: string, current: string): Promise<string | null> {
        const modal = this.injector.get(NgbModal).open(PromptModalComponent)
        modal.componentInstance.prompt = this.i18n.t(promptKey)
        modal.componentInstance.value = current
        try {
            const result = await modal.result
            // PromptModalComponent.ok() resolves with {value, remember};
            // cancel() resolves with null; backdrop/esc rejects.
            const value = result && typeof result === 'object' ? (result as any).value : result
            return typeof value === 'string' && value.length ? value : null
        } catch {
            return null // dismissed
        }
    }
}
