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
    SplitContainer,
    SplitTabComponent,
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
    MuxSessionTemplate,
    MuxSettings,
    MuxWindow,
    MuxWindowSpec,
} from './types'
import {
    captureLayout,
    deepClone,
    specPaneAt,
    specPanes,
    tokenToSpec,
} from './template.model'
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
    private readonly platform: PlatformService
    private readonly injector: Injector
    private readonly i18n: I18n

    private readonly windowByTab = new Map<BaseTabComponent, MuxWindow>()
    private readonly titleSubs = new Map<BaseTabComponent, Subscription>()
    private sessionSeq = 0
    private windowSeq = 0
    private suppressAdoption = 0
    private booted = false
    private profilesCache: { at: number, list: any[] } | null = null

    constructor (injector: Injector) {
        this.injector = injector
        this.app = injector.get(AppService)
        this.tabsService = injector.get(TabsService)
        this.profiles = injector.get(ProfilesService)
        this.config = injector.get(ConfigService)
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

    /**
     * New sessions are unnamed by default - the index is displayed as a
     * separate element and the display title falls back to the foreground
     * window's title, so numbers never get baked into the name.
     */
    newSession (name?: string | null): MuxSession {
        const requested = (name ?? this.settings.defaultSessionName ?? '').trim()
        const session: MuxSession = {
            id: `s${this.sessionSeq++}`,
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
            this.attachSession(session)
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
    attachSession (session: MuxSession): void {
        this.relistSessionWindows(session)
        this.attachedSessionId = session.id
        const current = session.windows[Math.max(0, session.currentWindowIndex)]
        if (current) {
            this.app.selectTab(current.tab)
        }
        this.moveForeignTabsToTail()
        this.changed$.next()
    }

    /**
     * Restores the listing invariant for `session`: un-lists every other
     * session's windows and lists `session`'s. Returns whether the tab bar
     * changed at all - callers use this to distinguish "nothing to do" from
     * an actual heal. Never touches the selection.
     */
    private relistSessionWindows (session: MuxSession): boolean {
        let mutated = false
        for (const other of this.sessions) {
            if (other === session) {
                continue
            }
            for (const win of [...other.windows]) {
                const index = this.app.tabs.indexOf(win.tab)
                if (index !== -1) {
                    this.app.removeTab(win.tab)
                    mutated = true
                }
            }
        }
        for (const win of session.windows) {
            if (!this.app.tabs.includes(win.tab)) {
                this.app.addTabRaw(win.tab)
                mutated = true
            }
        }
        return mutated
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
                // Real attach switch: full attach, selection included.
                this.attachSession(keep)
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
            if (!win.tab.getAllTabs().length) {
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
            this.attachSession(session)
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
        if (!win.tab.getAllTabs().length) {
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

    /** Searchable picker over the live sessions' windows (editor import). */
    async pickSessionWindow (): Promise<MuxWindow | null> {
        const options = []
        for (const session of this.sessions) {
            session.windows.forEach((win, i) => {
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
        const paneProfile = (win?.tab.getFocusedTab() as any)?.profile
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
