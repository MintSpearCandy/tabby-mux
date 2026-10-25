import { CommonModule } from '@angular/common'
import { NgModule } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { DragDropModule } from '@angular/cdk/drag-drop'
import { NgbDropdownModule, NgbNavModule } from '@ng-bootstrap/ng-bootstrap'
import TabbyCoreModule, {
    CommandProvider,
    ConfigProvider,
    HotkeyProvider,
    ToolbarButtonProvider,
} from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'
import { MuxCommandProvider } from './commands'
import { MuxConfigProvider } from './configProvider'
import { MuxHotkeyProvider } from './hotkeys'
import { MuxToolbarButtonProvider } from './toolbar'
import { MuxSettingsComponent } from './settings/muxSettings.component'
import { MuxSettingsTabProvider } from './settings/settingsTabProvider'

@NgModule({
    imports: [CommonModule, FormsModule, DragDropModule, NgbNavModule, NgbDropdownModule, TabbyCoreModule],
    // useClass everywhere: useExisting on provider tokens throws
    // NullInjectorError during bootstrap and takes every user plugin down.
    providers: [
        { provide: ConfigProvider, useClass: MuxConfigProvider, multi: true },
        { provide: HotkeyProvider, useClass: MuxHotkeyProvider, multi: true },
        { provide: CommandProvider, useClass: MuxCommandProvider, multi: true },
        { provide: ToolbarButtonProvider, useClass: MuxToolbarButtonProvider, multi: true },
        { provide: SettingsTabProvider, useClass: MuxSettingsTabProvider, multi: true },
    ],
    declarations: [
        MuxSettingsComponent,
    ],
})
export default class TabbyMuxModule { }

export * from './types'
export { MuxService } from './mux.service'
export { MuxCommandProvider, MUX_COMMANDS } from './commands'
