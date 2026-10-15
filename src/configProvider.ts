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
        hotkeys: {
            [HOTKEY_PREFIX]: Object.fromEntries(
                MUX_COMMANDS.map(cmd => [hotkeyConfigKey(cmd.id), []]),
            ),
        },
    }
}
