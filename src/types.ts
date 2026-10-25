import type { SplitTabComponent } from 'tabby-core'

/**
 * tmux session -> MuxSession: a named logical group of windows.
 * One Tabby window (top-level tab) hosts at most one mux session at a time;
 * sessions exist only as runtime state for now (no detach/persistence yet).
 */
export interface MuxSession {
    id: string
    name: string
    createdAt: number
    windows: MuxWindow[]
    /** Index into `windows` of the currently selected window. */
    currentWindowIndex: number
    /** Index of the previously used window (tmux shows it as `-`). */
    lastWindowIndex: number
}

/**
 * tmux window -> MuxWindow: one top-level Tabby tab (SplitTabComponent).
 * The tab may contain a single pane or a whole split layout tree.
 *
 * Multi-host: a window's live tab lives in exactly ONE OS window (renderer).
 * Hosts that do not own it keep a stub entry (`tab: null`, `hostWindowId`
 * pointing at the owning renderer); the display title of a stub is the
 * last broadcast `remoteTitle`.
 */
export interface MuxWindow {
    /** Globally unique: `w<hostWindowId>.<seq>` - ids must never collide across hosts. */
    id: string
    /** Custom name; null = derive from the tab's dynamic title. */
    name: string | null
    /** Live tab; null while another OS window hosts this window. */
    tab: SplitTabComponent | null
    session: MuxSession
    /** OS window id of the renderer hosting the live tab. */
    hostWindowId: number
    /** Display title cache for remotely-hosted windows (broadcast by the host). */
    remoteTitle: string | null
}

/**
 * tmux pane -> the child tabs of the SplitTabComponent. Panes are not wrapped
 * in plugin-side objects; they are queried live via `tab.getAllTabs()` /
 * `tab.getFocusedTab()` so the native split engine stays the single source of
 * truth for layout, focus and resize.
 */

export interface MuxStatusBarConfig {
    enabled: boolean
    height: number
    showPaneInfo: boolean
    showCpu: boolean
    showMem: boolean
    /** System resource sampling interval in ms (>= 500). */
    resourceIntervalMs: number
}

export interface MuxSidebarConfig {
    enabled: boolean
    width: number
}

/**
 * A pane's terminal source. Reference semantics: `profileId` points at a
 * live Tabby profile and is resolved at apply time (edits to the profile
 * are picked up); once the user modifies the config, the pane forks to an
 * embedded `profile` copy stored with the template ("修改后独立保存").
 * Exactly one of the two is set.
 */
export interface MuxPaneSpec {
    profileId: string | null
    profile: any | null
}

/** Layout tree: a container splits its children by orientation + ratios. */
export interface MuxLayoutContainer {
    orientation: 'h' | 'v'
    ratios: number[]
    children: MuxLayoutNode[]
    pane?: undefined
}

/** Layout tree: a leaf holds one pane spec. */
export interface MuxLayoutLeaf {
    pane: MuxPaneSpec
    children?: undefined
}

export type MuxLayoutNode = MuxLayoutContainer | MuxLayoutLeaf

export function isLayoutContainer (node: MuxLayoutNode | any): node is MuxLayoutContainer {
    return node && Array.isArray(node.children)
}

export interface MuxWindowSpec {
    layout: MuxLayoutContainer
}

/**
 * A saved workspace snapshot: a list of window layout specs. Applying a
 * template rebuilds each window with fresh shells (profiles resolved from
 * references or embedded copies - not running processes).
 */
export interface MuxSessionTemplate {
    id: string
    name: string
    /** Optional group heading, mirroring the profiles page's grouping. */
    group?: string
    createdAt: number
    windows: MuxWindowSpec[]
}

export interface MuxSettings {
    statusBar: MuxStatusBarConfig
    sidebar: MuxSidebarConfig
    /** Show the session index as a separate element (rail rows, status bar chips). */
    showSessionIndex: boolean
    /** Saved session templates (whole-array assignment persists, see MuxService). */
    templates: MuxSessionTemplate[]
    /** Explicitly created template groups (may be empty of templates). */
    templateGroups: string[]
    /** Group names whose list sections are collapsed. */
    collapsedGroups: string[]
    /** Adopt top-level terminal tabs opened outside the plugin into the active session. */
    autoAdoptWindows: boolean
    /** Name for auto-created sessions; null = unnamed (index shown separately, title falls back to the window title). */
    defaultSessionName: string | null
    /** Profile id used for new windows; null = inherit focused pane, then first local profile. */
    newWindowProfile: string | null
    /**
     * tmux-style attachment: only the attached session's windows are listed
     * in the tab bar; other sessions' windows are soft-removed (terminals
     * keep running) and restored when their session is attached.
     */
    isolatedSessions: boolean
    /**
     * On every session switch, move non-mux top-level tabs (welcome page,
     * settings, ...) behind all listed windows. Pinned tabs are exempt
     * (the host enforces pin ordering).
     */
    foreignTabsToTail: boolean
}

export function defaultMuxSettings (): MuxSettings {
    return {
        statusBar: {
            enabled: true,
            height: 26,
            showPaneInfo: true,
            showCpu: true,
            showMem: true,
            resourceIntervalMs: 2000,
        },
        sidebar: { enabled: true, width: 150 },
        showSessionIndex: true,
        templates: [],
        templateGroups: [],
        collapsedGroups: [],
        autoAdoptWindows: true,
        defaultSessionName: null,
        newWindowProfile: null,
        isolatedSessions: true,
        foreignTabsToTail: false,
    }
}

// ======================================================================
// Multi-host (window pull-out) types
// ======================================================================

/** Window entry as broadcast between OS windows. */
export interface MuxWindowDTO {
    id: string
    name: string | null
    hostWindowId: number
    title: string | null
}

/** Session snapshot as broadcast between OS windows. */
export interface MuxSessionDTO {
    id: string
    name: string
    createdAt: number
    currentWindowIndex: number
    windows: MuxWindowDTO[]
}

/**
 * A pending window handover, stashed in the SHARED localStorage so a target
 * renderer that is still booting (a brand-new OS window) can pick it up;
 * alive targets get nudged over the BroadcastChannel. `claim`:
 *  - number: only that host window id may take it (merge into existing host)
 *  - 'new': claimed by the next host that boots AFTER the entry was created
 */
export interface PullStashEntry {
    id: string
    claim: number | 'new'
    sessionId: string
    sessionName: string
    /** Creation timestamp of the source session - keeps global ordering stable in the recovering host. */
    sessionCreatedAt: number
    windowId: string
    windowName: string | null
    /** Tear-off drop point: the recovering window lands here at boot. */
    bounds?: { x: number, y: number, width: number, height: number } | null
    /** SplitTab recovery token (children carry restoreFromPTYID + savedState). */
    token: any
    ts: number
}
