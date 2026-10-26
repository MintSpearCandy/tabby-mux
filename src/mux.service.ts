import { Injectable, Injector } from '@angular/core'
import { Subject, Subscription } from 'rxjs'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import {
    AppService,
    BaseTabComponent,
    ConfigService,
    HostAppService,
    HostWindowService,
    HotkeysService,
    MenuItemOptions,
    PlatformService,
    ProfilesService,
    PromptModalComponent,
    SelectorService,
    SplitContainer,
    SplitTabComponent,
    TabRecoveryService,
    TabsService,
} from 'tabby-core'
import { CONFIG_KEY, DEBUG_HANDLE } from './configKeys'
import { MUX_COMMANDS } from './commands'
import { I18n } from './i18n'
import {
    defaultMuxSettings,
    isLayoutContainer,
    MuxLayoutNode,
    MuxPaneSpec,
    MuxSession,
    MuxSessionDTO,
    MuxSessionTemplate,
    MuxSettings,
    MuxWindow,
    MuxWindowSpec,
    PullStashEntry,
} from './types'
import {
    captureLayout,
    deepClone,
    specPaneAt,
    specPanes,
    tokenToSpec,
} from './template.model'
import { MuxStatusbarService } from './statusbar.service'
import { MuxTearoffService } from './tearoff'
import { MuxSidebarService } from './sidebar.service'
import { MuxSyncService } from './sync'

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
    private readonly platform: PlatformService
    private readonly injector: Injector
    private readonly i18n: I18n
    private readonly sync: MuxSyncService
    private readonly hostApp: HostAppService
    private readonly hostWindow: HostWindowService
    private readonly tabRecovery: TabRecoveryService

    private readonly windowByTab = new Map<BaseTabComponent, MuxWindow>()
    private readonly titleSubs = new Map<BaseTabComponent, Subscription>()
    /** Windows handed over to another host; destroyed here once `win-hosted` lands. */
    private readonly pendingHandover = new Map<string, { win: MuxWindow, entryId: string, timer: any }>()
    private sessionSeq = 0
    private windowSeq = 0
    private suppressAdoption = 0
    private booted = false
    private profilesCache: { at: number, list: any[] } | null = null
    private snapshotDirty = false
    private snapshotTimer: any = null

    constructor (injector: Injector) {
        this.injector = injector
        this.app = injector.get(AppService)
        this.tabsService = injector.get(TabsService)
        this.profiles = injector.get(ProfilesService)
        this.config = injector.get(ConfigService)
        this.platform = injector.get(PlatformService)
        this.i18n = injector.get(I18n)
        this.sync = injector.get(MuxSyncService)
        this.hostApp = injector.get(HostAppService)
        this.hostWindow = injector.get(HostWindowService)
        this.tabRecovery = injector.get(TabRecoveryService)

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

    /**
     * The globally active session - sessions outrank windows, and switching
     * (from ANY window) is global. Every host replicates this id; windows
     * that host none of the active session's windows hide until it becomes
     * active again.
     */
    private globalSessionId: string | null = null

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
        if (win.name) {
            return win.name
        }
        if (win.tab) {
            return win.tab.title ?? ''
        }
        return win.remoteTitle ?? ''
    }

    /** Whether the live tab of this window lives in THIS renderer. */
    hostsWindow (win: MuxWindow | null | undefined): boolean {
        return !!win?.tab && win.hostWindowId === this.sync.hostWindowId
    }

    /** True in the first OS window; pop-out windows get reduced chrome. */
    get isMainWindowHost (): boolean {
        return this.sync.isMainWindow
    }

    /** This renderer's OS window id (Tabby BrowserWindow id). */
    get hostWindowId (): number {
        return this.sync.hostWindowId
    }

    /** Opens one more Tabby OS window (the tear-off drag creates its target this way). */
    openNewHostWindow (): void {
        this.hostApp.newWindow()
    }

    findWindowById (id: string): { session: MuxSession, win: MuxWindow } | null {
        for (const session of this.sessions) {
            const win = session.windows.find(w => w.id === id)
            if (win) {
                return { session, win }
            }
        }
        return null
    }

    // ==================================================================
    // Session operations
    // ==================================================================

    /**
     * New sessions are unnamed by default - the index is displayed as a
     * separate element and the display title falls back to the foreground
     * window's title, so numbers never get baked into the name.
     */
    newSession (name?: string | null): MuxSession {
        const requested = (name ?? this.settings.defaultSessionName ?? '').trim()
        const session: MuxSession = {
            // Host-qualified ids: sessionSeq counts per renderer, so a bare
            // `s0` would collide with every other host's first session and
            // snapshot merges would fuse unrelated sessions (renames crossing
            // hosts, windows jumping sessions, isolation sweeping hosted tabs
            // off the bar - the pull-out "entry broken" report, 2026-10-25).
            id: `s${this.sync.hostWindowId}.${this.sessionSeq++}`,
            name: requested,
            createdAt: Date.now(),
            windows: [],
            currentWindowIndex: -1,
            lastWindowIndex: -1,
        }
        this.sessions.push(session)
        this.changed$.next()
        return session
    }

    /** Display position of a session (0-based, per the rail / status bar). */
    sessionIndex (session: MuxSession): number {
        return this.sessions.indexOf(session)
    }

    /**
     * Named sessions show their name; unnamed ones dynamically show the
     * foreground window's title (live - title changes re-render the bars).
     */
    sessionDisplayName (session: MuxSession): string {
        const named = (session.name ?? '').trim()
        if (named) {
            return named
        }
        const win = session.windows[Math.max(0, session.currentWindowIndex)] ?? session.windows[0]
        return win ? this.windowTitle(win) : ''
    }

    async createSessionWithWindow (name?: string | null): Promise<MuxSession> {
        const session = this.newSession(name)
        await this.newWindow(session)
        // Attach AFTER the window exists. Attaching up front is racy under
        // rapid creation: each call suspends in profile resolution, so a
        // later call rewrites attachedSessionId before this call's window
        // lands - the window then belongs to a non-attached session and (with
        // the registerWindow sweep) stays correctly un-listed until this
        // final attach sweeps the bar and lists it. Last attach wins.
        if (this.isolated) {
            this.attachSession(session, { global: true })
        }
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

    /**
     * Bulk close (context menu: others / before / after / all). More than
     * one target asks for confirmation first - killSession closes terminals
     * without the per-tab canClose prompt.
     */
    async killSessions (targets: MuxSession[]): Promise<void> {
        const list = targets.filter(s => this.sessions.includes(s))
        if (!list.length) {
            return
        }
        if (list.length > 1) {
            const result = await this.platform.showMessageBox({
                type: 'warning',
                message: this.i18n.t('mux.session.killManyConfirm', { n: list.length }),
                buttons: [this.i18n.t('mux.paneModal.cancel'), this.i18n.t('mux.session.killButton')],
                defaultId: 0,
                cancelId: 0,
            })
            if (result.response !== 1) {
                return
            }
        }
        for (const session of [...list]) {
            await this.killSession(session)
        }
    }

    // ==================================================================
    // Session attachment (tmux-style tab bar isolation)
    // ==================================================================

    /**
     * Attaches a session with a FULL sweep: un-lists every other session's
     * windows, not just the previously attached one. Window creation is
     * async (profile resolution + PTY spawn), so concurrent
     * createSessionWithWindow calls can land windows of several sessions in
     * the bar; sweeping here restores the isolation invariant no matter how
     * the bar got polluted (2026-10-18: detaching only the previous session
     * leaked those windows permanently - switching sessions never removed
     * them). Soft-removal keeps components and terminal sessions alive:
     * app.removeTab does not destroy tabs, and the destroyed tab-body only
     * detaches the host view; addTabRaw re-creates a tab-body whose
     * ngOnChanges re-inserts the view so the terminal renders again.
     */
    attachSession (session: MuxSession, opts?: { global?: boolean }): void {
        this.relistSessionWindows(session)
        this.attachedSessionId = session.id
        // Prefer the session's current window, but only a locally-hosted tab
        // can be selected here; a remote one stays with its own OS window.
        const current = session.windows[Math.max(0, session.currentWindowIndex)]
        const target = this.hostsWindow(current) ? current : session.windows.find(w => this.hostsWindow(w))
        if (target) {
            this.app.selectTab(target.tab!)
        }
        // Session workspace model: this window is a view of the active
        // session. Holding any of its windows => make sure we are on screen
        // (a window hidden by an earlier switch comes back); holding none =>
        // hide (its background windows keep running, tmux-detach style).
        // The main window never hides - it is the management anchor and the
        // default focus target on every switch.
        if (target) {
            this.showSelfIfHidden()
        } else {
            this.hideSelfIfNotMain()
        }
        this.moveForeignTabsToTail()
        // Global switch: any window may switch; everyone follows. The flag
        // is set only on user-facing funnels (session switch commands,
        // dead-session takeover), never on local reconciles - applyIsolation
        // runs in every host on every config save and must not re-broadcast.
        if (opts?.global && this.isolated) {
            this.globalSessionId = session.id
            // Snapshot FIRST, then the switch: a freshly created session is
            // unknown to peers until a snapshot reaches them (the lazy 2s
            // flush lags this immediate broadcast), and an unknown id makes
            // the receiver drop the switch silently. Same-channel messages
            // are FIFO, so this order guarantees the stub exists first.
            this.sync.send({
                t: 'snapshot',
                host: this.sync.hostWindowId,
                sessions: this.snapshotDto(),
                global: this.globalSessionId,
            })
            this.sync.send({ t: 'attach-session', host: this.sync.hostWindowId, sessionId: session.id })
            // Focus lands on the main window by default on every switch.
            if (this.sync.isMainWindow) {
                this.hostWindow.bringToFront()
            }
        }
        this.changed$.next()
    }

    /**
     * Restores the listing invariant for `session`: un-lists every other
     * session's windows and lists `session`'s. Returns whether the tab bar
     * changed at all - callers use this to distinguish "nothing to do" from
     * an actual heal. Never touches the selection. Remote-hosted windows
     * (tab: null) have no local tab and are skipped by both directions.
     */
    private relistSessionWindows (session: MuxSession): boolean {
        let mutated = false
        for (const other of this.sessions) {
            if (other === session) {
                continue
            }
            for (const win of [...other.windows]) {
                if (!win.tab) {
                    continue
                }
                const index = this.app.tabs.indexOf(win.tab)
                if (index !== -1) {
                    this.app.removeTab(win.tab)
                    mutated = true
                }
            }
        }
        for (const win of session.windows) {
            if (win.tab && !this.app.tabs.includes(win.tab)) {
                this.app.addTabRaw(win.tab)
                mutated = true
            }
        }
        return mutated
    }

    /** Mode-aware session switch (status bar chips, switch-session commands). */
    switchToSession (session: MuxSession): void {
        if (this.isolated) {
            this.attachSession(session, { global: true })
            return
        }
        const current = session.windows[Math.max(0, session.currentWindowIndex)]
        const win = this.hostsWindow(current) ? current : session.windows.find(w => this.hostsWindow(w))
        if (win) {
            this.app.selectTab(win.tab!)
        }
        this.moveForeignTabsToTail()
    }

    /**
     * Moves non-mux top-level tabs (welcome page, settings, ...) behind all
     * listed windows on session switches - opt-in via settings. Sequential
     * move-to-end keeps their relative order; moveTabToIndex is a pure
     * splice + tabsChanged (never touches the active tab) and clamps to pin
     * bounds, so pinned tabs stay in front (explicit user override).
     */
    private moveForeignTabsToTail (): void {
        if (!this.settings.foreignTabsToTail) {
            return
        }
        // moveTabToIndex exists at runtime (host >= 1.0.237) but is missing
        // from the tabby-core@1.0.231-nightly typings.
        const appAny = this.app as any
        if (typeof appAny.moveTabToIndex !== 'function') {
            return
        }
        for (const tab of this.app.tabs.filter(t => !this.windowByTab.has(t))) {
            appAny.moveTabToIndex(tab, this.app.tabs.length - 1)
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
            if (this.attachedSessionId !== keep.id) {
                // Real attach switch: full attach, selection included. This
                // only fires on genuine transitions (boot-time first attach,
                // desync heal) - plain config saves take the relist-only
                // branch below - so it is a legitimate global selection.
                this.attachSession(keep, { global: true })
                return
            }
            // Reconcile of the ALREADY-attached session - this runs on every
            // config.changed$, i.e. on every settings tweak. Restore the
            // listing invariant but keep the selection: the user may well be
            // on the settings/welcome page, and re-selecting the session's
            // current window yanked them away on every save (2026-10-18
            // regression from the attachSession rewrite).
            if (this.relistSessionWindows(keep)) {
                this.moveForeignTabsToTail()
                this.changed$.next()
            }
        } else {
            // Mixed mode: every session's locally-hosted windows are listed.
            for (const session of this.sessions) {
                for (const win of session.windows) {
                    if (win.tab && !this.app.tabs.includes(win.tab)) {
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
     * session. Mirrors tmux `new-window`. Pure creation: in isolation mode
     * the window is un-listed right away unless its session is the attached
     * one (see registerWindow); callers that want the session in view attach
     * after creating.
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

    /**
     * Explicit kill (tmux kill-window semantics - no prompts). The user
     * already decided via the menu/command; canClose here would stall the
     * whole flow on native per-pane dialogs (and on the close-confirm patch
     * in pop-out windows), which is how remote-routed kills used to hang.
     */
    async killWindow (win: MuxWindow | null): Promise<void> {
        if (!win) {
            return
        }
        if (!this.hostsWindow(win)) {
            // Hosted in another OS window: the owning host performs the real
            // destroy (shells live there) and broadcasts win-gone; our stub
            // is pruned when that lands.
            this.sync.send({ t: 'kill-win', host: this.sync.hostWindowId, windowId: win.id })
            return
        }
        const tab = win.tab!
        if (this.app.tabs.includes(tab)) {
            await this.app.closeTab(tab)
        } else {
            // Detached window: closeTab only works on listed tabs. Destroying
            // directly still fires tabRemoved$ (via addTabRaw's destroyed$
            // subscription), so the registry prunes itself.
            tab.destroy()
        }
    }

    /**
     * Local select when this host owns the window; otherwise a cross-host
     * foreground: the owning host selects the tab and brings its OS window
     * to front (window-bring-to-front also restores a minimized window).
     */
    selectWindow (win: MuxWindow): void {
        if (this.hostsWindow(win)) {
            this.app.selectTab(win.tab!)
            return
        }
        this.sync.send({ t: 'focus-win', host: this.sync.hostWindowId, windowId: win.id })
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
        // from the tabby-core@1.0.231-nightly typings. Remote stubs have no
        // local tab; their name reaches the owner through the snapshot.
        if (win.tab) {
            ;(win.tab as any).setCustomTitle(trimmed)
        }
        this.markSnapshotDirty()
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
     * Captures a session's workspace as layout specs, read directly from the
     * live SplitContainer trees (no recovery-token round-trip, so freshly
     * created windows capture reliably). Panes whose profile still matches
     * the registry are stored as references; modified ones embed a copy.
     */
    async saveSessionAsTemplate (session: MuxSession | null, name: string): Promise<MuxSessionTemplate | null> {
        const trimmed = name.trim()
        if (!session || !trimmed || !session.windows.length) {
            return null
        }
        const registry = await this.profiles.getProfiles()
        const windows: MuxWindowSpec[] = []
        for (const win of session.windows) {
            // Remote-hosted windows cannot be captured here (their layout
            // tree lives in another renderer); templates cover local windows.
            if (!win.tab || !win.tab.getAllTabs().length) {
                continue
            }
            windows.push({ layout: captureLayout(win.tab.root, tab => (tab as any).profile, registry) })
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
        const result = await this.promptText('mux.templatePrompt', this.sessionDisplayName(session))
        if (result === null) {
            return null
        }
        return this.saveSessionAsTemplate(session, result)
    }

    /**
     * Rebuilds a session from a template in two phases:
     *
     *  1. Synchronously create EVERY window shell (SplitTab + registration).
     *     No awaits - the full window list appears in the tab bar instantly
     *     and the session is immediately switchable/renamable. Attaching
     *     first (isolated mode) keeps every shell listed, so no
     *     add-then-sweep churn per shell.
     *  2. Fill the panes one window at a time in the background. Reference
     *     panes resolve their profile at apply time ("连接式直取"); embedded
     *     panes use their stored copy.
     */
    async createSessionFromTemplate (template: MuxSessionTemplate): Promise<MuxSession | null> {
        const specs = template.windows.filter(w => specPanes(w.layout).length)
        if (!specs.length) {
            return null
        }
        const session = this.newSession(template.name)
        if (this.isolated) {
            this.attachSession(session, { global: true })
        }
        const shells: SplitTabComponent[] = []
        for (const windowSpec of specs) {
            const split = this.tabsService.create({ type: SplitTabComponent })
            // tabOpened$ fires SYNCHRONOUSLY inside addTabRaw, so the
            // adoption suppression only needs to cover this call.
            this.suppressAdoption++
            try {
                this.app.addTabRaw(split)
            } finally {
                this.suppressAdoption--
            }
            // Placeholder until the panes exist (cleared after filling);
            // '' clears the custom title back to the dynamic one.
            ;(split as any).setCustomTitle?.('…')
            this.registerWindow(session, split)
            shells.push(split)
        }
        // addTabRaw selects each shell as it lands, which leaves the LAST
        // window in the foreground - the tmux semantic is the first window.
        const first = session.windows[0]
        if (first) {
            this.app.selectTab(first.tab)
        }
        this.changed$.next()
        void this.fillWindowsProgressively(session, specs, shells)
        return session
    }

    /**
     * Phase 2: fills template shells one window at a time. Panes never pass
     * through AppService.addTabRaw, so no adoption suppression is needed
     * here. A shell the user closed meanwhile is skipped; a window whose
     * panes cannot be built (e.g. profile deleted since the template was
     * saved) is destroyed rather than left as a zombie empty tab.
     */
    private async fillWindowsProgressively (
        session: MuxSession, specs: MuxWindowSpec[], shells: SplitTabComponent[],
    ): Promise<void> {
        for (let i = 0; i < shells.length; i++) {
            const split = shells[i]
            if (!session.windows.some(w => w.tab === split)) {
                continue
            }
            let filled = false
            try {
                filled = await this.fillWindowFromSpec(split, specs[i])
            } catch {
                filled = false
            }
            if (filled) {
                // Load in window order: window N's shells must be live
                // before window N+1 starts spawning, so the visible loading
                // (spawn burst, tab titles resolving) follows the window
                // order from the first window instead of overlapping.
                await this.waitPanesSpawned(split)
            }
            ;(split as any).setCustomTitle?.('')
            if (!filled && session.windows.some(w => w.tab === split)) {
                split.destroy()
            }
        }
    }

    /**
     * Waits until every pane of the window has a session object. For local
     * profiles the pty spawn happens synchronously (ipc sendSync) inside
     * session creation, so this gate serializes the shell-spawn load window
     * by window. Bounded: a pane that never initializes (broken profile)
     * must not block later windows forever.
     */
    private async waitPanesSpawned (split: SplitTabComponent, timeoutMs = 10_000): Promise<void> {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
            if (!split.getAllTabs().some(t => !(t as any).session)) {
                return
            }
            await new Promise(resolve => setTimeout(resolve, 100))
        }
    }

    /**
     * Populates an already-created window shell from a layout spec: one
     * terminal per leaf, attached to the split, then a real SplitContainer
     * tree with the authored orientation/ratios. The shell must have been
     * listed (its view initializes the subjects this awaits).
     */
    private async fillWindowFromSpec (split: SplitTabComponent, spec: MuxWindowSpec): Promise<boolean> {
        const leaves = specPanes(spec.layout)
        if (!leaves.length) {
            return false
        }
        const registry = await this.getProfilesCached()
        // addTabRaw rendered the shell only after a change-detection pass;
        // the split engine itself awaits this before attaching views.
        await split.initialized$.toPromise()
        const tabsByPath = new Map<string, BaseTabComponent>()
        for (const info of leaves) {
            const profile = info.profileId
                ? registry.find(p => p.id === info.profileId) ?? null
                : null
            const resolved = profile ?? deepClone(specPaneAt(spec.layout, info.path)?.profile ?? null)
            if (!resolved) {
                continue
            }
            const params = await this.profiles.newTabParametersForProfile(resolved)
            if (!params) {
                continue
            }
            const tab = this.tabsService.create(params)
            tab.parent = split
            ;(split as any).attachTabView(tab)
            tabsByPath.set(info.path.join('.'), tab)
        }
        const buildTree = (node: MuxLayoutNode, path: number[]): SplitContainer | BaseTabComponent | null => {
            if (!isLayoutContainer(node)) {
                return tabsByPath.get(path.join('.')) ?? null
            }
            const container = new SplitContainer()
            container.orientation = node.orientation
            for (let i = 0; i < node.children.length; i++) {
                const child = buildTree(node.children[i], [...path, i])
                if (child) {
                    container.children.push(child)
                }
            }
            if (!container.children.length) {
                return null
            }
            container.ratios = container.children.map((_, i) => node.ratios?.[i] ?? 1 / container.children.length)
            return container
        }
        const tree = buildTree(spec.layout, [])
        if (!tree || !(tree instanceof SplitContainer) || !tree.getAllTabs().length) {
            return false
        }
        split.root = tree
        split.layout()
        await this.activatePanes(split)
        ;(split as any).updateTitle?.()
        return true
    }

    /**
     * A terminal pane attaches its frontend (and with it the ResizeObserver
     * -> resize -> frontendReady -> session spawn chain) only when it is or
     * becomes focused - baseTerminalTab.component.ts defers attach until the
     * pane's first focused$ emission. The host's own split path focuses every
     * pane as it is added; a spec fill builds the tree directly, so without
     * this sweep every pane except the first would stay frontend-less (blank
     * and session-less) until clicked. Re-focuses pending panes until all
     * frontends report ready (retries absorb change-detection timing), then
     * focuses the first pane like the host does.
     */
    private async activatePanes (split: SplitTabComponent, timeoutMs = 8_000): Promise<void> {
        const panes = split.getAllTabs()
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
            const pending = panes.filter(t => !(t as any).frontendIsReady)
            if (!pending.length) {
                break
            }
            for (const pane of pending) {
                split.focus(pane)
            }
            await new Promise(resolve => setTimeout(resolve, 150))
        }
        if (panes.length) {
            split.focus(panes[0])
        }
    }

    async deleteTemplate (template: MuxSessionTemplate): Promise<void> {
        this.config.store[CONFIG_KEY].templates = this.templates.filter(t => t !== template)
        await this.config.save()
        this.changed$.next()
    }

    /** Persists an edited template (matched by id), whole-array style. */
    async saveTemplateEdit (edited: MuxSessionTemplate): Promise<void> {
        const next = this.templates.map(t => t.id === edited.id ? edited : t)
        this.config.store[CONFIG_KEY].templates = next
        await this.config.save()
        this.changed$.next()
    }

    /** Captures one live session window as a layout spec (editor import). */
    async captureWindowSpec (win: MuxWindow): Promise<MuxWindowSpec | null> {
        if (!win.tab || !win.tab.getAllTabs().length) {
            return null
        }
        const registry = await this.profiles.getProfiles()
        return { layout: captureLayout(win.tab.root, tab => (tab as any).profile, registry) }
    }

    /**
     * Promotes an embedded pane config into a real Tabby profile
     * ("保存为新的连接与配置") and switches the pane to reference it.
     */
    async promotePaneProfile (pane: MuxPaneSpec, name: string): Promise<string | null> {
        const trimmed = name.trim()
        if (!pane.profile || !trimmed) {
            return null
        }
        const profile = deepClone(pane.profile)
        profile.name = trimmed
        await this.profiles.newProfile(profile)
        pane.profileId = profile.id
        pane.profile = null
        this.changed$.next()
        return profile.id ?? null
    }

    /**
     * Boot migration: templates saved in the legacy recovery-token format
     * are converted to layout specs once. Never throws - a malformed entry
     * is skipped rather than failing startup.
     */
    private async migrateTemplates (): Promise<void> {
        try {
            let changed = false
            const registry = await this.profiles.getProfiles()
            const migrated = this.templates.map(tpl => {
                try {
                    const isLegacy = tpl.windows?.some((w: any) => w?.type === 'app:split-tab' || w?.layout === undefined)
                    if (!isLegacy) {
                        return tpl
                    }
                    changed = true
                    return {
                        ...tpl,
                        windows: (tpl.windows ?? []).map((w: any) => w?.layout ? w : tokenToSpec(w, registry)),
                    }
                } catch {
                    return tpl
                }
            })
            if (changed) {
                this.config.store[CONFIG_KEY].templates = migrated
                await this.config.save()
                this.changed$.next()
            }
        } catch {
            // migration is best-effort
        }
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

    /** The host's searchable profile/connection picker. */
    async pickProfile (): Promise<any | null> {
        return await this.profiles.showProfileSelector()
    }

    /** Searchable picker over the live sessions' locally-hosted windows (editor import). */
    async pickSessionWindow (): Promise<MuxWindow | null> {
        const options = []
        for (const session of this.sessions) {
            session.windows.forEach((win, i) => {
                if (!win.tab) {
                    return
                }
                options.push({
                    name: `${this.i18n.t('mux.edit.window', { n: i + 1 })} · ${this.sessionDisplayName(session)}`,
                    description: this.windowTitle(win),
                    icon: 'fas fa-window-maximize',
                    result: win,
                })
            })
        }
        if (!options.length) {
            return null
        }
        const selector = this.injector.get(SelectorService)
        return await selector.show<MuxWindow>(this.i18n.t('mux.edit.importWindow'), options)
    }

    /** Public text-prompt wrapper for list-level template operations. */
    async promptForText (key: string, current: string): Promise<string | null> {
        return await this.promptText(key, current)
    }

    /** Right-click menu for a session (rail entries, status bar chips). */
    sessionContextMenu (session: MuxSession, event: MouseEvent): void {
        const index = this.sessionIndex(session)
        const others = this.sessions.filter(s => s !== session)
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
            {
                label: this.i18n.t('mux.session.killOthers'),
                enabled: others.length > 0,
                click: () => void this.killSessions(others),
            },
            {
                label: this.i18n.t('mux.session.killBefore'),
                enabled: index > 0,
                click: () => void this.killSessions(this.sessions.slice(0, index)),
            },
            {
                label: this.i18n.t('mux.session.killAfter'),
                enabled: index < this.sessions.length - 1,
                click: () => void this.killSessions(this.sessions.slice(index + 1)),
            },
            {
                label: this.i18n.t('mux.session.killAll'),
                enabled: this.sessions.length > 0,
                click: () => void this.killSessions([...this.sessions]),
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

    /** Right-click menu for a session window (status bar window chips). */
    windowContextMenu (win: MuxWindow, event: MouseEvent): void {
        const items: MenuItemOptions[] = []
        if (this.hostsWindow(win)) {
            items.push({
                label: this.i18n.t('mux.mw.moveToNew'),
                click: () => void this.moveWindowTo(win, 'new'),
            })
            if (this.sync.knownHosts().length) {
                items.push({
                    label: this.i18n.t('mux.mw.moveToOther'),
                    click: () => void this.promptMoveWindow(win),
                })
            }
            items.push({ type: 'separator' })
        }
        items.push({
            label: this.i18n.t('mux.renameWindow'),
            click: () => void this.renameWindowPrompt(win),
        })
        items.push({ type: 'separator' })
        items.push({
            label: this.i18n.t('mux.killWindow'),
            click: () => void this.killWindow(win),
        })
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
            const profiles = await this.getProfilesCached()
            const found = profiles.find(p => p.id === configuredId)
            if (found) {
                return found
            }
        }
        // Inherit the profile of the session's focused pane (tmux-like).
        const win = session.windows[Math.max(0, session.currentWindowIndex)]
        const paneProfile = (this.hostsWindow(win) ? win!.tab!.getFocusedTab() : null as any)?.profile
        if (paneProfile) {
            return paneProfile
        }
        const profiles = await this.getProfilesCached()
        return profiles.find(p => p.type === 'local') ?? null
    }

    /**
     * ProfilesService.getProfiles() has no host-side cache: every call
     * re-runs the builtin providers (fs scans for shells, SSH config
     * imports). That disk work dominates the cost of rapid session creation,
     * so the creation path reads through a short-lived cache here. Profile
     * edits go through config.save() -> config.changed$, which invalidates
     * immediately; the TTL only bounds staleness of rarely-changing builtin
     * shell listings.
     */
    private async getProfilesCached (): Promise<any[]> {
        if (this.profilesCache && Date.now() - this.profilesCache.at < 30_000) {
            return this.profilesCache.list
        }
        const list = await this.profiles.getProfiles()
        this.profilesCache = { at: Date.now(), list }
        return list
    }

    private registerWindow (session: MuxSession, tab: SplitTabComponent, fixedId?: string): MuxWindow {
        // Host-qualified ids: two renderers creating windows concurrently
        // must never mint the same id (replication matches on it).
        const id = fixedId ?? `w${this.sync.hostWindowId}.${this.windowSeq++}`
        // A stub for this window may already exist (snapshots announced the
        // pull before this host recovered it) - adopt it in place instead of
        // appending a duplicate entry.
        const existing = session.windows.find(w => w.id === id)
        const win: MuxWindow = existing ?? {
            id,
            name: null,
            tab,
            session,
            hostWindowId: this.sync.hostWindowId,
            remoteTitle: null,
        }
        if (existing) {
            existing.tab = tab
            existing.hostWindowId = this.sync.hostWindowId
            existing.remoteTitle = null
        } else {
            session.windows.push(win)
        }
        this.windowByTab.set(tab, win)
        this.titleSubs.set(tab, tab.titleChange$.subscribe(() => this.changed$.next()))
        if (!this.sync.isMainWindow) {
            this.installCloseConfirm(tab)
        }
        const winIndex = session.windows.indexOf(win)
        // addTabRaw selects the new tab BEFORE this registration runs, so the
        // activeTabChange$ event already flew past trackActiveWindow with the
        // tab still unregistered. Sync indices here to avoid a desync where
        // currentWindowIndex points at the previously active window.
        if (this.app.activeTab === tab) {
            if (session.currentWindowIndex >= 0 && session.currentWindowIndex !== winIndex) {
                session.lastWindowIndex = session.currentWindowIndex
            }
            session.currentWindowIndex = winIndex
        } else if (session.currentWindowIndex < 0) {
            session.currentWindowIndex = winIndex
        }
        // Isolation invariant at the source: a window registered for a
        // session that is not the attached one must not stay listed. Windows
        // land via addTabRaw (which lists + selects them) before the caller
        // can attach their session, so without this sweep rapid concurrent
        // creations leak each other's terminals into the tab bar. Soft
        // removal - the window lives on as a background session window.
        if (this.isolated && session.id !== this.attachedSessionId &&
            this.app.tabs.includes(tab)) {
            this.app.removeTab(tab)
        }
        // addTabRaw APPENDS, so a freshly landed window sits behind foreign
        // tabs. Every window passes through here (new window, template
        // shells, adoption) - re-asserting the order here keeps the
        // foreign-tabs-at-tail invariant without relying on each caller.
        if (this.app.tabs.includes(tab)) {
            this.moveForeignTabsToTail()
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
        this.config.changed$.subscribe(() => {
            this.profilesCache = null
            this.applyIsolationSetting()
        })
        try {
            this.injector.get(MuxTearoffService).start()
        } catch {
            // tear-off choreography is additive
        }

        // Multi-host mesh: every registry mutation marks the snapshot dirty;
        // a 2s flush broadcasts it (titles churn often, payloads are tiny).
        // Explicit ops (win-hosted/win-gone/focus-win) travel immediately.
        this.changed$.subscribe(() => this.markSnapshotDirty())
        this.sync.hostDied$.subscribe(host => this.pruneRemoteHost(host))
        this.sync.received$.subscribe(ev => this.handleSyncEvent(ev))
        try {
            this.sync.gcStash()
            this.sync.start(() => ({ sessions: this.snapshotDto(), global: this.globalSessionId }))
        } catch {
            // sync-less operation: local sessions still work
        }
        try {
            void this.processPullStash()
        } catch {
            // a claimed entry that fails to recover times out on the source
        }

        // Boot-time helpers must never take the whole plugin (and with it
        // the app) down - a malformed persisted template is data, not a
        // reason to fail startup.
        try {
            void this.migrateTemplates()
        } catch {
            // ignore - templates stay in whatever form they are in
        }
        try {
            this.applyIsolationSetting()
        } catch {
            // fall back to whatever the tab bar looks like now
        }
        try {
            this.injector.get(MuxStatusbarService).start()
        } catch {
            // status bar is cosmetic
        }
        try {
            this.injector.get(MuxSidebarService).start()
        } catch {
            // rail is cosmetic
        }

        this.changed$.next()
    }

    // ==================================================================
    // Multi-host: window pull-out / merge (see sync.ts for the transport)
    // ==================================================================

    /** Other hosts currently available as move targets (context menus, picker). */
    moveTargetHosts (): number[] {
        return this.sync.knownHosts()
    }

    /** Which other host's window contains the given screen point, if any. */
    dropTargetHostAt (x: number, y: number): number | null {
        const margin = 16
        for (const host of this.sync.knownHosts()) {
            const b = this.sync.hostBounds(host)
            if (b && x >= b.x - margin && x <= b.x + b.w + margin &&
                y >= b.y - margin && y <= b.y + b.h + margin) {
                return host
            }
        }
        return null
    }

    /** Palette command: pick a target (new window or a known host) and move. */
    async promptMoveWindow (win: MuxWindow | null): Promise<void> {
        if (!this.hostsWindow(win)) {
            return
        }
        const selector = this.injector.get(SelectorService)
        const options: { name: string, icon: string, result: 'new' | number }[] = [
            { name: this.i18n.t('mux.mw.newWindow'), icon: 'fas fa-external-link-alt', result: 'new' },
        ]
        for (const host of this.sync.knownHosts()) {
            options.push({ name: this.i18n.t('mux.mw.hostTarget', { id: host }), icon: 'fas fa-window-restore', result: host })
        }
        const chosen = await selector.show<'new' | number>(this.i18n.t('mux.moveWindow'), options)
        if (chosen !== null && chosen !== undefined) {
            await this.moveWindowTo(win!, chosen)
        }
    }

    /**
     * Moves a locally-hosted window to another OS window. The recovery token
     * (children carry restoreFromPTYID + serialized screen state) is stashed
     * in the SHARED localStorage; the target renderer recovers it into a live
     * SplitTab attached to the very same PTYs, then confirms with win-hosted.
     * Only then is the local tab destroyed with sessions marked open=false -
     * the normal destroy chain would kill the shared shells.
     */
    async moveWindowTo (win: MuxWindow | null, target: 'new' | number, opts?: { bounds?: { x: number, y: number, width: number, height: number } }): Promise<boolean> {
        if (!this.hostsWindow(win) || this.pendingHandover.has(win!.id)) {
            return false
        }
        const token = await win!.tab!.getRecoveryToken({ includeState: true })
        if (!token) {
            return false
        }
        const entry: PullStashEntry = {
            id: `pull-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
            claim: target === 'new' ? 'new' : target,
            sessionId: win!.session.id,
            sessionName: win!.session.name,
            sessionCreatedAt: win!.session.createdAt,
            windowId: win!.id,
            windowName: win!.name,
            bounds: opts?.bounds ?? null,
            token,
            ts: Date.now(),
        }
        const pending = { win: win!, entryId: entry.id, timer: null as any }
        this.pendingHandover.set(win!.id, pending)
        this.sync.pushStash(entry)
        if (target === 'new') {
            try {
                this.hostApp.newWindow()
            } catch {
                // stash entry stays; an already-open host may still claim it
            }
        }
        this.sync.send({ t: 'check-stash' })
        // Abort guard: a target that never comes up leaves the window here.
        pending.timer = setTimeout(() => this.abortHandover(win!.id), 60_000)
        return true
    }

    private abortHandover (windowId: string): void {
        const pending = this.pendingHandover.get(windowId)
        if (!pending) {
            return
        }
        this.pendingHandover.delete(windowId)
        clearTimeout(pending.timer)
        this.sync.removeStashEntry(pending.entryId)
        this.changed$.next()
    }

    /** Target side: claim and recover stash entries addressed to this host. */
    private async processPullStash (): Promise<void> {
        const entries = this.sync.claimStashEntries(e => {
            if (e.claim === this.sync.hostWindowId) {
                return true
            }
            // 'new' entries belong to a window booted AFTER they were stashed;
            // the main window (first boot, before any stash existed) never
            // claims, and neither does any restarted-app main window.
            return e.claim === 'new' && !this.sync.isMainWindow && this.sync.bootTime > (e.ts ?? 0)
        })
        for (const entry of entries) {
            await this.recoverPulledWindow(entry)
        }
    }

    private async recoverPulledWindow (entry: PullStashEntry): Promise<void> {
        try {
            // The tear-off drop point: apply before anything else so the
            // window settles at the placeholder's position as early as its
            // (already visible) boot allows.
            if (entry.bounds?.width) {
                try {
                    ;(this.hostWindow as any).getWindow?.()?.setBounds?.(entry.bounds)
                } catch {
                    // positioning is cosmetic
                }
            }
            const params = await this.tabRecovery.recoverTab(entry.token)
            if (!params) {
                return // source-side timeout re-hosts the window
            }
            let session = this.sessions.find(s => s.id === entry.sessionId)
            if (!session) {
                session = {
                    id: entry.sessionId,
                    name: entry.sessionName ?? '',
                    // The source session's creation time, not local now():
                    // session order is global (createdAt sort), and a
                    // locally-stamped stub would sort as brand new.
                    createdAt: entry.sessionCreatedAt ?? Date.now(),
                    windows: [],
                    currentWindowIndex: -1,
                    lastWindowIndex: -1,
                }
                this.sessions.push(session)
                this.sortSessions()
            }
            // Fresh host: attach without the global sweep - nothing else is
            // listed here and the sweep would fight the recovery below.
            if (this.isolated && this.attachedSessionId !== session.id &&
                !session.windows.some(w => this.hostsWindow(w))) {
                this.attachedSessionId = session.id
            }
            this.suppressAdoption++
            let split: SplitTabComponent
            try {
                // Recovery tokens type as BaseTabComponent parameters; a
                // split-tab token recovers to a SplitTabComponent at runtime
                // (the old template-apply path relied on the same fact).
                split = this.tabsService.create(params as any)
                this.app.addTabRaw(split)
            } finally {
                this.suppressAdoption--
            }
            const win = this.registerWindow(session, split, entry.windowId)
            win.name = entry.windowName ?? null
            // Recovered panes attach to live PTYs but the frontend attach is
            // focus-gated (see activatePanes) - sweep them explicitly.
            await this.activatePanes(split)
            ;(split as any).updateTitle?.()
            this.sync.send({ t: 'win-hosted', host: this.sync.hostWindowId, windowId: entry.windowId })
            this.changed$.next()
        } catch {
            // leave the entry consumed; the source-side timeout re-hosts
        }
    }

    /**
     * Source side of a completed handover: convert the window entry to a
     * remote stub and destroy the local tab WITHOUT killing the shells -
     * BaseSession.destroy() runs gracefullyKillProcess(), but both destroy
     * chains are gated on `session.open`, so clearing the flag first makes
     * every pane release its PTY listeners harmlessly. The now-orphaned pty
     * listeners are detached too (destroyed$ never fires on this path).
     */
    private async releaseLocalTab (win: MuxWindow): Promise<void> {
        const tab = win.tab
        if (!tab) {
            return
        }
        this.windowByTab.delete(tab)
        this.titleSubs.get(tab)?.unsubscribe()
        this.titleSubs.delete(tab)
        win.tab = null
        win.remoteTitle = tab.title ?? null
        // Un-list first: destroy of a listed tab fires the same registry
        // chain as a real close (which would broadcast win-gone).
        if (this.app.tabs.includes(tab)) {
            this.app.removeTab(tab)
        }
        for (const pane of tab.getAllTabs()) {
            const session = (pane as any).session
            if (session) {
                session.open = false
                try {
                    ;(session as any).pty?.unsubscribeAll?.()
                } catch {
                    // listener cleanup is best-effort
                }
            }
        }
        try {
            await tab.destroy()
        } catch {
            // the shells live on in the other host either way
        }
        this.changed$.next()
    }

    /** Removes every window of a host that stopped broadcasting (crash/close). */
    private pruneRemoteHost (host: number): void {
        let changed = false
        for (const session of [...this.sessions]) {
            const survivors = session.windows.filter(w => w.hostWindowId !== host)
            if (survivors.length !== session.windows.length) {
                session.windows = survivors
                changed = true
            }
        }
        this.sessions = this.sessions.filter(s => {
            if (s.windows.length) {
                return true
            }
            // A session whose every window died with that host is gone; if it
            // was attached, hand the bar to the newest survivor (or welcome).
            if (this.attachedSessionId === s.id) {
                this.attachedSessionId = null
                if (this.isolated && this.sessions.length > 1) {
                    const next = this.sessions[this.sessions.length - 1]
                    if (next !== s) {
                        this.attachSession(next, { global: true })
                    }
                }
            }
            return false
        })
        if (changed) {
            this.changed$.next()
        }
    }

    private handleSyncEvent (ev: any): void {
        try {
            switch (ev?.t) {
                case 'hello':
                    this.sync.replySnapshot()
                    break
                case 'snapshot':
                    if (typeof ev.global === 'string' && ev.global) {
                        this.globalSessionId = ev.global
                    }
                    this.applySnapshot(ev.sessions)
                    break
                case 'attach-session': {
                    // Global session switch, possibly triggered by any
                    // window. Follow locally (attach hides/shows this window
                    // per its share of the new session); the main window also
                    // takes focus - the switch default. Never re-broadcast.
                    if (typeof ev.sessionId === 'string' && ev.sessionId) {
                        this.globalSessionId = ev.sessionId
                    }
                    const session = this.sessions.find(s => s.id === ev.sessionId)
                    if (session && this.isolated) {
                        this.attachSession(session)
                        if (this.sync.isMainWindow) {
                            this.hostWindow.bringToFront()
                        }
                    }
                    break
                }
                case 'win-hosted': {
                    const pending = this.pendingHandover.get(ev.windowId)
                    if (pending) {
                        this.pendingHandover.delete(ev.windowId)
                        clearTimeout(pending.timer)
                        void this.releaseLocalTab(pending.win)
                    }
                    break
                }
                case 'win-gone': {
                    const found = this.findWindowById(ev.windowId)
                    if (found && !found.win.tab) {
                        found.session.windows = found.session.windows.filter(w => w !== found.win)
                        if (!found.session.windows.length) {
                            this.sessions = this.sessions.filter(s => s !== found.session)
                            if (this.attachedSessionId === found.session.id) {
                                this.attachedSessionId = null
                                if (this.isolated && this.sessions.length) {
                                    this.attachSession(this.sessions[this.sessions.length - 1], { global: true })
                                }
                            }
                        }
                        this.changed$.next()
                    }
                    break
                }
                case 'focus-win': {
                    const found = this.findWindowById(ev.windowId)
                    if (found && this.hostsWindow(found.win)) {
                        // The target window may be a hidden secondary whose
                        // bar was emptied by a session switch (its session
                        // got soft-removed) - re-attach first so the tab is
                        // actually listed, then select and unhide.
                        if (this.isolated && this.attachedSessionId !== found.session.id) {
                            this.attachSession(found.session)
                        }
                        this.app.selectTab(found.win.tab!)
                        this.hostWindow.bringToFront()
                        this.markSnapshotDirty()
                    }
                    break
                }
                case 'kill-win': {
                    const found = this.findWindowById(ev.windowId)
                    if (found && this.hostsWindow(found.win)) {
                        void this.killWindow(found.win)
                    }
                    break
                }
                case 'check-stash':
                    void this.processPullStash()
                    break
            }
        } catch {
            // a malformed peer message must never destabilize this host
        }
    }

    /**
     * Merges a peer's registry view. Locally-hosted live tabs always win
     * (this renderer is their source of truth); everything else adopts the
     * sender's fields, and window order follows the sender's sequence.
     */
    private applySnapshot (dto: any): void {
        if (!Array.isArray(dto)) {
            return
        }
        let changed = false
        for (const sd of dto) {
            if (!sd || typeof sd.id !== 'string') {
                continue
            }
            let session = this.sessions.find(s => s.id === sd.id)
            if (!session) {
                session = {
                    id: sd.id,
                    name: typeof sd.name === 'string' ? sd.name : '',
                    createdAt: sd.createdAt ?? Date.now(),
                    windows: [],
                    currentWindowIndex: typeof sd.currentWindowIndex === 'number' ? sd.currentWindowIndex : -1,
                    lastWindowIndex: -1,
                }
                this.sessions.push(session)
                changed = true
            } else if (session.name !== (sd.name ?? '')) {
                session.name = sd.name ?? ''
                changed = true
            }
            const known = new Map(session.windows.map(w => [w.id, w]))
            const windows: any[] = Array.isArray(sd.windows) ? sd.windows : []
            for (const wd of windows) {
                if (!wd || typeof wd.id !== 'string') {
                    continue
                }
                const win = known.get(wd.id)
                const mineLive = win && this.hostsWindow(win) && !this.pendingHandover.has(wd.id)
                if (mineLive) {
                    continue
                }
                if (win) {
                    if (win.hostWindowId !== wd.hostWindowId) {
                        win.hostWindowId = wd.hostWindowId
                        changed = true
                    }
                    if ((win.remoteTitle ?? '') !== (wd.title ?? '')) {
                        win.remoteTitle = wd.title ?? ''
                        changed = true
                    }
                    const name = wd.name ?? null
                    if ((win.name ?? null) !== (name ?? null)) {
                        win.name = name
                        changed = true
                    }
                } else {
                    session.windows.push({
                        id: wd.id,
                        name: wd.name ?? null,
                        tab: null,
                        hostWindowId: wd.hostWindowId,
                        remoteTitle: wd.title ?? null,
                        session,
                    })
                    changed = true
                }
            }
            // Order by the sender's sequence; windows it does not know keep
            // their relative positions (stable sort).
            const order = new Map(windows.map((w: any, i: number) => [w.id as string, i]))
            const before = session.windows.map(w => w.id).join('|')
            session.windows.sort((a, b) => {
                const ai = order.get(a.id)
                const bi = order.get(b.id)
                if (ai !== undefined && bi !== undefined) {
                    return ai - bi
                }
                if (ai !== undefined) {
                    return -1
                }
                if (bi !== undefined) {
                    return 1
                }
                return 0
            })
            if (session.windows.map(w => w.id).join('|') !== before) {
                changed = true
            }
            // Spectators adopt the sender's current-window pointer; a host
            // with its own windows in the session tracks it locally.
            if (!session.windows.some(w => this.hostsWindow(w)) &&
                typeof sd.currentWindowIndex === 'number' &&
                sd.currentWindowIndex !== session.currentWindowIndex) {
                session.currentWindowIndex = sd.currentWindowIndex
                changed = true
            }
        }
        if (this.sortSessions()) {
            changed = true
        }
        if (changed) {
            this.changed$.next()
        }
    }

    /**
     * Session order is GLOBAL. Without this sort each host's array is
     * "local creations, then snapshot stubs in arrival order" - two hosts
     * creating sessions interleaved end up with swapped orders (visible in
     * the status bar chips and the switch-session cycling). createdAt is
     * the canonical key (monotonic per host, distinct in practice; the id
     * tiebreak keeps equal timestamps deterministic everywhere).
     */
    private sortSessions (): boolean {
        const before = this.sessions.map(s => s.id).join('|')
        this.sessions.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        return this.sessions.map(s => s.id).join('|') !== before
    }

    private snapshotDto (): MuxSessionDTO[] {
        return this.sessions.map(s => ({
            id: s.id,
            name: s.name,
            createdAt: s.createdAt,
            currentWindowIndex: s.currentWindowIndex,
            windows: s.windows.map(w => ({
                id: w.id,
                name: w.name,
                hostWindowId: w.hostWindowId,
                title: this.windowTitle(w) || null,
            })),
        }))
    }

    private markSnapshotDirty (): void {
        this.snapshotDirty = true
        if (this.snapshotTimer !== null) {
            return
        }
        this.snapshotTimer = setTimeout(() => {
            this.snapshotTimer = null
            if (!this.snapshotDirty) {
                return
            }
            this.snapshotDirty = false
            this.sync.send({
                t: 'snapshot',
                host: this.sync.hostWindowId,
                sessions: this.snapshotDto(),
                global: this.globalSessionId,
            })
        }, 2_000)
    }

    /**
     * Close confirmation for mux windows in non-main OS windows: closing the
     * OS window (or its tabs) would terminate the hosted shells - one mux
     * dialog replaces the per-pane native prompts for the whole window.
     */
    private installCloseConfirm (tab: SplitTabComponent): void {
        const target = tab as any
        const original = target.canClose?.bind(tab)
        target.canClose = async (): Promise<boolean> => {
            if (!this.windowByTab.has(tab)) {
                return original ? original() : true
            }
            const panes = tab.getAllTabs()
            const result = await this.platform.showMessageBox({
                type: 'warning',
                message: this.i18n.t('mux.mw.closeConfirm', { n: panes.length }),
                buttons: [this.i18n.t('mux.mw.closeKill'), this.i18n.t('mux.paneModal.cancel')],
                defaultId: 1,
                cancelId: 1,
            })
            return result.response === 0
        }
    }

    /**
     * Window visibility follows the active session. HostWindowService
     * (tabby-core) has no hide/show; the Electron host exposes the
     * BrowserWindow via getWindow(). Both are best-effort - on a host
     * without them the window just stays visible.
     */
    private hideSelfIfNotMain (): void {
        try {
            if (this.sync.isMainWindow || this.app.tabs.length) {
                return
            }
            ;(this.hostWindow as any).getWindow?.()?.hide?.()
        } catch {
            // cosmetic
        }
    }

    /** Reappearing with content must not steal focus from the main window. */
    private showSelfIfHidden (): void {
        try {
            if (this.sync.isMainWindow) {
                return
            }
            const win = (this.hostWindow as any).getWindow?.()
            if (typeof win?.showInactive === 'function') {
                win.showInactive()
            } else {
                win?.show?.()
            }
        } catch {
            // cosmetic
        }
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
        // releaseLocalTab un-registers BEFORE destroying, so reaching here
        // means the window really ended (closed/killed) - tell the mesh so
        // stub holders prune it too.
        this.sync.send({ t: 'win-gone', host: this.sync.hostWindowId, windowId: win.id })
        session.windows = session.windows.filter(w => w !== win)
        if (!session.windows.length) {
            // tmux kills a session when its last window closes; when the
            // attached session dies, the most recently created remaining one
            // takes over the tab bar.
            this.sessions = this.sessions.filter(s => s !== session)
            if (this.attachedSessionId === session.id) {
                this.attachedSessionId = null
                if (this.isolated && this.sessions.length) {
                    this.attachSession(this.sessions[this.sessions.length - 1], { global: true })
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
