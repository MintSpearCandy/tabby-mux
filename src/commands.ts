import { Command, CommandProvider } from 'tabby-core'
import { Injectable, Injector } from '@angular/core'
import { I18n } from './i18n'
import { MuxService } from './mux.service'

/**
 * One command spec drives three surfaces at once:
 *  - palette entries (CommandProvider below)
 *  - hotkey descriptions (`<id>` maps to the `hotkeys.mux.*` config subtree)
 *  - hotkey dispatch (MuxService.runCommand routes `hotkey$` ids here)
 */
export interface MuxCommandSpec {
    id: string
    labelKey: string
    /** Requires a mux window to be the active tab. */
    needsWindow?: boolean
    /** Requires at least one mux session to exist. */
    needsSession?: boolean
    run: (mux: MuxService) => any
}

function selectWindowCommand (index: number): MuxCommandSpec {
    return {
        id: `mux.select-window-${index}`,
        labelKey: 'mux.selectWindow',
        needsSession: true,
        run: mux => mux.selectWindowIndex(mux.activeSession, index),
    }
}

export const MUX_COMMANDS: MuxCommandSpec[] = [
    // ---- sessions ----
    {
        id: 'mux.new-session',
        labelKey: 'mux.newSession',
        run: mux => mux.createSessionWithWindow(),
    },
    {
        id: 'mux.rename-session',
        labelKey: 'mux.renameSession',
        needsSession: true,
        run: mux => mux.renameSessionPrompt(mux.activeSession),
    },
    {
        id: 'mux.switch-session-next',
        labelKey: 'mux.switchSessionNext',
        needsSession: true,
        run: mux => mux.switchSession(1),
    },
    {
        id: 'mux.switch-session-prev',
        labelKey: 'mux.switchSessionPrev',
        needsSession: true,
        run: mux => mux.switchSession(-1),
    },
    {
        id: 'mux.kill-session',
        labelKey: 'mux.killSession',
        needsSession: true,
        run: mux => mux.killSession(mux.activeSession),
    },
    // ---- windows ----
    {
        id: 'mux.new-window',
        labelKey: 'mux.newWindow',
        needsSession: true,
        run: mux => mux.newWindow(),
    },
    {
        id: 'mux.rename-window',
        labelKey: 'mux.renameWindow',
        needsWindow: true,
        run: mux => mux.renameWindowPrompt(mux.activeWindow),
    },
    {
        id: 'mux.kill-window',
        labelKey: 'mux.killWindow',
        needsWindow: true,
        run: mux => mux.killWindow(mux.activeWindow),
    },
    {
        id: 'mux.next-window',
        labelKey: 'mux.nextWindow',
        needsSession: true,
        run: mux => mux.stepWindow(1),
    },
    {
        id: 'mux.previous-window',
        labelKey: 'mux.previousWindow',
        needsSession: true,
        run: mux => mux.stepWindow(-1),
    },
    ...Array.from({ length: 9 }, (_, i) => selectWindowCommand(i)),
    // ---- panes ----
    {
        id: 'mux.split-pane-right',
        labelKey: 'mux.splitPaneRight',
        needsWindow: true,
        run: mux => mux.splitPane('h'),
    },
    {
        id: 'mux.split-pane-bottom',
        labelKey: 'mux.splitPaneBottom',
        needsWindow: true,
        run: mux => mux.splitPane('v'),
    },
    {
        id: 'mux.kill-pane',
        labelKey: 'mux.killPane',
        needsWindow: true,
        run: mux => mux.killPane(),
    },
    {
        id: 'mux.next-pane',
        labelKey: 'mux.nextPane',
        needsWindow: true,
        run: mux => mux.stepPane(1),
    },
    {
        id: 'mux.previous-pane',
        labelKey: 'mux.previousPane',
        needsWindow: true,
        run: mux => mux.stepPane(-1),
    },
    {
        id: 'mux.pane-left',
        labelKey: 'mux.paneLeft',
        needsWindow: true,
        run: mux => mux.navigatePane('l'),
    },
    {
        id: 'mux.pane-right',
        labelKey: 'mux.paneRight',
        needsWindow: true,
        run: mux => mux.navigatePane('r'),
    },
    {
        id: 'mux.pane-up',
        labelKey: 'mux.paneUp',
        needsWindow: true,
        run: mux => mux.navigatePane('t'),
    },
    {
        id: 'mux.pane-down',
        labelKey: 'mux.paneDown',
        needsWindow: true,
        run: mux => mux.navigatePane('b'),
    },
    {
        id: 'mux.pane-zoom',
        labelKey: 'mux.paneZoom',
        needsWindow: true,
        run: mux => mux.togglePaneZoom(),
    },
    {
        id: 'mux.pane-equalize',
        labelKey: 'mux.paneEqualize',
        needsWindow: true,
        run: mux => mux.equalizePanes(),
    },
    {
        id: 'mux.pane-grow-vertical',
        labelKey: 'mux.paneGrowVertical',
        needsWindow: true,
        run: mux => mux.resizePane('v'),
    },
    {
        id: 'mux.pane-shrink-vertical',
        labelKey: 'mux.paneShrinkVertical',
        needsWindow: true,
        run: mux => mux.resizePane('dv'),
    },
    {
        id: 'mux.pane-grow-horizontal',
        labelKey: 'mux.paneGrowHorizontal',
        needsWindow: true,
        run: mux => mux.resizePane('h'),
    },
    {
        id: 'mux.pane-shrink-horizontal',
        labelKey: 'mux.paneShrinkHorizontal',
        needsWindow: true,
        run: mux => mux.resizePane('dh'),
    },
    // ---- misc ----
    {
        id: 'mux.save-session-template',
        labelKey: 'mux.saveSessionTemplate',
        needsSession: true,
        run: mux => mux.saveSessionAsTemplatePrompt(mux.activeSession),
    },
    {
        id: 'mux.toggle-statusbar',
        labelKey: 'mux.toggleStatusbar',
        run: mux => mux.toggleStatusbar(),
    },
    {
        id: 'mux.toggle-isolation',
        labelKey: 'mux.toggleIsolation',
        run: mux => mux.toggleIsolation(),
    },
    {
        id: 'mux.toggle-sidebar',
        labelKey: 'mux.toggleSidebar',
        run: mux => mux.toggleSidebar(),
    },
]

/** Suffix of `mux.<id>` in the `hotkeys.mux` config subtree. */
export function hotkeyConfigKey (id: string): string {
    return id.replace(/^mux\./, '')
}

@Injectable()
export class MuxCommandProvider extends CommandProvider {
    // Constructor params must never reference MuxService: a type-only import
    // cannot satisfy emitDecoratorMetadata, which then emits `Function` as the
    // design:paramtypes token - Angular injects the literal Function
    // constructor and the whole bootstrap dies with NullInjectorError.
    // Resolve through the Injector at provide() time instead.
    constructor (private injector: Injector) {
        super()
    }

    async provide (): Promise<Command[]> {
        // The mux.service -> commands -> mux.service import cycle is safe:
        // this module never touches MuxService during its own evaluation,
        // only here, long after both modules are fully loaded.
        const mux = this.injector.get(MuxService)
        const i18n = this.injector.get(I18n)
        const out: Command[] = []
        for (const spec of MUX_COMMANDS) {
            if (spec.needsSession && !mux.sessions.length) {
                continue
            }
            if (spec.needsWindow && !mux.activeWindow) {
                continue
            }
            const command = new Command()
            command.id = spec.id
            const n = spec.id.match(/select-window-(\d)$/)?.[1]
            command.label = n ? i18n.t(spec.labelKey, { n }) : i18n.t(spec.labelKey)
            command.run = async () => {
                await spec.run(mux)
            }
            out.push(command)
        }
        // One dynamic entry per saved template (palette-only, no hotkeys).
        for (const tpl of mux.templates) {
            const apply = new Command()
            apply.id = `mux.apply-template:${tpl.id}`
            apply.label = i18n.t('mux.applySessionTemplate', { name: tpl.name })
            apply.run = async () => {
                await mux.createSessionFromTemplate(tpl)
            }
            out.push(apply)
        }
        return out
    }
}
