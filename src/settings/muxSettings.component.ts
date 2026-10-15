import { Component, OnInit } from '@angular/core'
import { ConfigService, ProfilesService } from 'tabby-core'
import { I18n } from '../i18n'
import { CONFIG_KEY } from '../configKeys'

/**
 * Settings page for tabby-mux. Values bind straight onto the config proxy
 * (declared in MuxConfigProvider defaults, so writes persist); every change
 * saves immediately.
 */
@Component({
    selector: 'mux-settings',
    template: `
        <h2>{{ t('mux.settings.statusbarSection') }}</h2>
        <div class="form-check">
            <input type="checkbox" class="form-check-input" id="mux-sb-enabled"
                   [(ngModel)]="settings.statusBar.enabled" (ngModelChange)="save()">
            <label class="form-check-label" for="mux-sb-enabled">{{ t('mux.settings.sbEnabled') }}</label>
        </div>
        <div class="form-check">
            <input type="checkbox" class="form-check-input" id="mux-sb-pane"
                   [(ngModel)]="settings.statusBar.showPaneInfo" (ngModelChange)="save()">
            <label class="form-check-label" for="mux-sb-pane">{{ t('mux.settings.sbPaneInfo') }}</label>
        </div>
        <div class="form-check">
            <input type="checkbox" class="form-check-input" id="mux-sb-cpu"
                   [(ngModel)]="settings.statusBar.showCpu" (ngModelChange)="save()">
            <label class="form-check-label" for="mux-sb-cpu">{{ t('mux.settings.sbCpu') }}</label>
        </div>
        <div class="form-check">
            <input type="checkbox" class="form-check-input" id="mux-sb-mem"
                   [(ngModel)]="settings.statusBar.showMem" (ngModelChange)="save()">
            <label class="form-check-label" for="mux-sb-mem">{{ t('mux.settings.sbMem') }}</label>
        </div>
        <div class="mb-2">
            <label class="form-label" for="mux-sb-height">{{ t('mux.settings.sbHeight') }}</label>
            <input type="number" class="form-control" id="mux-sb-height" min="14" max="80"
                   [(ngModel)]="settings.statusBar.height" (ngModelChange)="save()">
        </div>
        <div class="mb-2">
            <label class="form-label" for="mux-sb-interval">{{ t('mux.settings.sbInterval') }}</label>
            <input type="number" class="form-control" id="mux-sb-interval" min="500" step="100"
                   [(ngModel)]="settings.statusBar.resourceIntervalMs" (ngModelChange)="save()">
        </div>

        <h2>{{ t('mux.settings.sidebarSection') }}</h2>
        <div class="form-check">
            <input type="checkbox" class="form-check-input" id="mux-rail-enabled"
                   [(ngModel)]="settings.sidebar.enabled" (ngModelChange)="save()">
            <label class="form-check-label" for="mux-rail-enabled">{{ t('mux.settings.railEnabled') }}</label>
        </div>
        <div class="mb-2">
            <label class="form-label" for="mux-rail-width">{{ t('mux.settings.railWidth') }}</label>
            <input type="number" class="form-control" id="mux-rail-width" min="80" max="400"
                   [(ngModel)]="settings.sidebar.width" (ngModelChange)="save()">
        </div>

        <h2>{{ t('mux.settings.sessionSection') }}</h2>
        <div class="form-check">
            <input type="checkbox" class="form-check-input" id="mux-isolated"
                   [(ngModel)]="settings.isolatedSessions" (ngModelChange)="save()">
            <label class="form-check-label" for="mux-isolated">{{ t('mux.settings.isolated') }}</label>
        </div>
        <div class="form-check">
            <input type="checkbox" class="form-check-input" id="mux-adopt"
                   [(ngModel)]="settings.autoAdoptWindows" (ngModelChange)="save()">
            <label class="form-check-label" for="mux-adopt">{{ t('mux.settings.autoAdopt') }}</label>
        </div>
        <div class="mb-2">
            <label class="form-label" for="mux-default-name">{{ t('mux.settings.defaultName') }}</label>
            <input type="text" class="form-control" id="mux-default-name" maxlength="40"
                   [ngModel]="settings.defaultSessionName ?? ''"
                   (ngModelChange)="settings.defaultSessionName = $event || null; save()">
        </div>
        <div class="mb-2">
            <label class="form-label" for="mux-profile">{{ t('mux.settings.profile') }}</label>
            <select class="form-select" id="mux-profile"
                    [ngModel]="settings.newWindowProfile ?? ''"
                    (ngModelChange)="settings.newWindowProfile = $event || null; save()">
                <option value="">{{ t('mux.settings.profileAuto') }}</option>
                <option *ngFor="let p of profiles" [ngValue]="p.id">{{ p.name }} ({{ p.type }})</option>
            </select>
        </div>
    `,
})
export class MuxSettingsComponent implements OnInit {
    settings: any
    profiles: any[] = []

    constructor (
        private config: ConfigService,
        private profilesService: ProfilesService,
        private i18n: I18n,
    ) { }

    ngOnInit (): void {
        this.settings = this.config.store[CONFIG_KEY]
        void this.profilesService.getProfiles().then(list => {
            this.profiles = list
        })
    }

    t (key: string): string {
        return this.i18n.t(key)
    }

    save (): void {
        void this.config.save()
    }
}
