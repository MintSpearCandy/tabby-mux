import { ConfigProvider } from 'tabby-core'
import { CONFIG_KEY, HOTKEY_PREFIX } from './configKeys'
import { defaultMuxSettings } from './types'
import { MUX_COMMANDS, hotkeyConfigKey } from './commands'

/**
 * Default chord assignments (2026-10-25, user decision). Format per host
 * hotkeys.util: dash-separated, code-based key names - Equal maps to '=',
 * Backslash to '\'. NOTE Ctrl-Shift-Up/Down collide with tabby-terminal's
 * builtin scroll-up/scroll-down defaults; among equal-length matches the
 * engine picks the first registered, so the builtin wins until the user
 * clears those bindings in Settings -> Hotkeys.
 */
const DEFAULT_BINDINGS: Record<string, string[]> = {
    'mux.new-session': ['Ctrl-Shift-='],
    'mux.switch-session-next': ['Ctrl-Shift-Down'],
    'mux.switch-session-prev': ['Ctrl-Shift-Up'],
    'mux.new-session-from-template': ['Ctrl-Shift-\\'],
}

export class MuxConfigProvider extends ConfigProvider {
    defaults = {
        [CONFIG_KEY]: defaultMuxSettings(),
        // The whole hotkeys.mux.* subtree MUST be declared here, even as empty
        // arrays. ConfigProxy silently drops user-made bindings for subtrees
        // that no ConfigProvider declared (they vanish from the settings UI
        // and from the hotkey engine on the next load).
        hotkeys: {
            [HOTKEY_PREFIX]: Object.fromEntries(
                MUX_COMMANDS.map(cmd => [hotkeyConfigKey(cmd.id), DEFAULT_BINDINGS[cmd.id] ?? []]),
            ),
        },
    }
}
