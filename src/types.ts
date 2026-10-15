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
 */
export interface MuxWindow {
    id: string
    /** Custom name; null = derive from the tab's dynamic title. */
    name: string | null
    tab: SplitTabComponent
    session: MuxSession
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
}

export interface MuxSettings {
    statusBar: MuxStatusBarConfig
    /** Adopt top-level terminal tabs opened outside the plugin into the active session. */
    autoAdoptWindows: boolean
    /** Name for auto-created sessions; null = sequential numbers like tmux (0, 1, 2...). */
    defaultSessionName: string | null
    /** Profile id used for new windows; null = inherit focused pane, then first local profile. */
    newWindowProfile: string | null
    /**
     * tmux-style attachment: only the attached session's windows are listed
     * in the tab bar; other sessions' windows are soft-removed (terminals
     * keep running) and restored when their session is attached.
     */
    isolatedSessions: boolean
}

export function defaultMuxSettings (): MuxSettings {
    return {
        statusBar: { enabled: true, height: 26, showPaneInfo: true },
        autoAdoptWindows: true,
        defaultSessionName: null,
        newWindowProfile: null,
        isolatedSessions: true,
    }
}
