import { ConfigProvider } from 'tabby-core'
import { CONFIG_KEY, HOTKEY_PREFIX } from './configKeys'
import { defaultMuxSettings } from './types'
import { MUX_COMMANDS, hotkeyConfigKey } from './commands'

export class MuxConfigProvider extends ConfigProvider {
    defaults = {
        [CONFIG_KEY]: defaultMuxSettings(),
        // The whole hotkeys.mux.* subtree MUST be declared here, even as empty
        // arrays. ConfigProxy silently drops user-made bindings for subtrees
        // that no ConfigProvider declared (they vanish from the settings UI
        // and from the hotkey engine on the next load).
        //
        // No default chords: the user-chosen candidates collided with
        // tabby-terminal builtins (zoom-in / scroll-up / scroll-down), and
        // the engine lets builtins win equal-length matches. All mux
        // commands stay discoverable in Settings -> Hotkeys by searching
        // "mux" (the filter matches name + id, and every id is mux.*).
        hotkeys: {
            [HOTKEY_PREFIX]: Object.fromEntries(
                MUX_COMMANDS.map(cmd => [hotkeyConfigKey(cmd.id), []]),
            ),
        },
    }
}
