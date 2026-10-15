import { Injectable, Injector } from '@angular/core'
import { Subject, Subscription } from 'rxjs'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import {
    AppService,
    BaseTabComponent,
    ConfigService,
    HotkeysService,
    ProfilesService,
    PromptModalComponent,
    SplitTabComponent,
    TabsService,
} from 'tabby-core'
import { CONFIG_KEY, DEBUG_HANDLE } from './configKeys'
import { MUX_COMMANDS } from './commands'
import { I18n } from './i18n'
import { defaultMuxSettings, MuxSession, MuxSettings, MuxWindow } from './types'
import { MuxStatusbarService } from './statusbar.service'

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

    /** Session of the currently active top-level tab, if it is a mux window. */
    get activeSession (): MuxSession | null {
        return this.activeWindow?.session ?? null
    }

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

    switchSession (delta: number): void {
        if (!this.sessions.length) {
            return
        }
        const current = this.sessions.indexOf(this.activeSession ?? this.sessions[0])
        const target = (current + delta + this.sessions.length) % this.sessions.length
        const session = this.sessions[target]
        const win = session.windows[Math.max(0, session.currentWindowIndex)]
        if (win) {
            this.app.selectTab(win.tab)
        }
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
        await this.app.closeTab(win.tab)
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

        this.injector.get(MuxStatusbarService).start()

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
            // tmux kills a session when its last window closes.
            this.sessions = this.sessions.filter(s => s !== session)
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
            return typeof result === 'string' ? result : null
        } catch {
            return null // dismissed
        }
    }
}
