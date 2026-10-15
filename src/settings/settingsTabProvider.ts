import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'tabby-settings'
import { CONFIG_KEY } from '../configKeys'
import { MuxSettingsComponent } from './muxSettings.component'

@Injectable()
export class MuxSettingsTabProvider extends SettingsTabProvider {
    // NB: the base class declares `title` as a property (not an accessor), so
    // it must stay a field here - overriding it with a getter is TS2611.
    // The label is locale-independent, which also sidesteps the "title is
    // snapshotted before LocaleService applies the configured language" trap.
    id = CONFIG_KEY
    icon = 'layer-group'
    title = 'Tabby Mux'
    prioritized = true

    getComponentType (): any {
        return MuxSettingsComponent
    }
}
