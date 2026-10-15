import { ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core'
import { ConfigService, ProfilesService } from 'tabby-core'
import { Subscription } from 'rxjs'
import { I18n } from '../i18n'
import { CONFIG_KEY } from '../configKeys'
import { MuxService } from '../mux.service'
import { MuxSessionTemplate } from '../types'

/**
 * Settings page for tabby-mux, organized in tabs. Values bind straight onto
 * the config proxy (declared in MuxConfigProvider defaults, so writes
 * persist); every change saves immediately. Row structure mirrors the
 * native settings pages (`.form-line`-style header + control), with
 * self-contained styling since the native classes are scoped to their
 * components.
 */
@Component({
    selector: 'mux-settings',
    styles: [`
        .mux-settings-tabs {
            display: flex;
            gap: 2px;
            border-bottom: 1px solid var(--theme-bg-less, rgba(128, 128, 128, .25));
            margin-bottom: 14px;
        }
        .mux-settings-tab {
            padding: 6px 14px;
            border: none;
            border-bottom: 2px solid transparent;
            margin-bottom: -1px;
            background: transparent;
            color: var(--theme-fg-more, #999);
            font-size: 13px;
            cursor: pointer;
        }
        .mux-settings-tab:hover { color: var(--theme-fg, #ccc); }
        .mux-settings-tab.is-active {
            color: var(--theme-fg, #ccc);
            border-bottom-color: var(--theme-primary, #0d6efd);
        }
        .mux-form-line {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 7px 0;
        }
        .mux-form-line .mux-line-header { flex: 1; min-width: 0; }
        .mux-form-line .mux-line-header .title { font-size: 13px; }
        .mux-form-line .mux-line-header .description {
            font-size: 12px;
            color: var(--theme-fg-more, #999);
        }
        .mux-form-line .mux-line-control { width: 220px; flex-shrink: 0; }
        .mux-form-line .form-check { margin: 0; }
        .mux-tpl-row {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 8px 10px;
            margin: 4px 0;
            border-radius: 5px;
            background: var(--theme-bg-more, rgba(128, 128, 128, .12));
        }
        .mux-tpl-row .mux-tpl-name { font-size: 13px; font-weight: 600; }
        .mux-tpl-row .mux-tpl-meta {
            font-size: 12px;
            color: var(--theme-fg-more, #999);
        }
        .mux-tpl-empty {
            padding: 16px 0;
            font-size: 13px;
            color: var(--theme-fg-more, #999);
        }
    `],
    template: `
        <h3 class="mb-3">Tabby Mux</h3>

        <div class="mux-settings-tabs" role="tablist">
            <button type="button" role="tab" class="mux-settings-tab"
                    [class.is-active]="tab === 'statusbar'"
                    (click)="tab = 'statusbar'">{{ t('mux.settings.tabStatusbar') }}</button>
            <button type="button" role="tab" class="mux-settings-tab"
                    [class.is-active]="tab === 'sidebar'"
                    (click)="tab = 'sidebar'">{{ t('mux.settings.tabSidebar') }}</button>
            <button type="button" role="tab" class="mux-settings-tab"
                    [class.is-active]="tab === 'sessions'"
                    (click)="tab = 'sessions'">{{ t('mux.settings.tabSessions') }}</button>
            <button type="button" role="tab" class="mux-settings-tab"
                    [class.is-active]="tab === 'templates'"
                    (click)="tab = 'templates'">{{ t('mux.settings.tabTemplates') }}</button>
        </div>

        <ng-container *ngIf="tab === 'statusbar'">
            <div class="mux-form-line">
                <div class="mux-line-header"><div class="title">{{ t('mux.settings.sbEnabled') }}</div></div>
                <div class="mux-line-control">
                    <div class="form-check form-switch">
                        <input type="checkbox" class="form-check-input" id="mux-sb-enabled"
                               [(ngModel)]="settings.statusBar.enabled" (ngModelChange)="save()">
                    </div>
                </div>
            </div>
            <div class="mux-form-line">
                <div class="mux-line-header"><div class="title">{{ t('mux.settings.sbPaneInfo') }}</div></div>
                <div class="mux-line-control">
                    <div class="form-check form-switch">
                        <input type="checkbox" class="form-check-input" id="mux-sb-pane"
                               [(ngModel)]="settings.statusBar.showPaneInfo" (ngModelChange)="save()">
                    </div>
                </div>
            </div>
            <div class="mux-form-line">
                <div class="mux-line-header"><div class="title">{{ t('mux.settings.sbCpu') }}</div></div>
                <div class="mux-line-control">
                    <div class="form-check form-switch">
                        <input type="checkbox" class="form-check-input" id="mux-sb-cpu"
                               [(ngModel)]="settings.statusBar.showCpu" (ngModelChange)="save()">
                    </div>
                </div>
            </div>
            <div class="mux-form-line">
                <div class="mux-line-header"><div class="title">{{ t('mux.settings.sbMem') }}</div></div>
                <div class="mux-line-control">
                    <div class="form-check form-switch">
                        <input type="checkbox" class="form-check-input" id="mux-sb-mem"
                               [(ngModel)]="settings.statusBar.showMem" (ngModelChange)="save()">
                    </div>
                </div>
            </div>
            <div class="mux-form-line">
                <div class="mux-line-header"><div class="title">{{ t('mux.settings.sbHeight') }}</div></div>
                <div class="mux-line-control">
                    <input type="number" class="form-control" id="mux-sb-height" min="14" max="80"
                           [(ngModel)]="settings.statusBar.height" (ngModelChange)="save()">
                </div>
            </div>
            <div class="mux-form-line">
                <div class="mux-line-header"><div class="title">{{ t('mux.settings.sbInterval') }}</div></div>
                <div class="mux-line-control">
                    <input type="number" class="form-control" id="mux-sb-interval" min="500" step="100"
                           [(ngModel)]="settings.statusBar.resourceIntervalMs" (ngModelChange)="save()">
                </div>
            </div>
        </ng-container>

        <ng-container *ngIf="tab === 'sidebar'">
            <div class="mux-form-line">
                <div class="mux-line-header"><div class="title">{{ t('mux.settings.railEnabled') }}</div></div>
                <div class="mux-line-control">
                    <div class="form-check form-switch">
                        <input type="checkbox" class="form-check-input" id="mux-rail-enabled"
                               [(ngModel)]="settings.sidebar.enabled" (ngModelChange)="save()">
                    </div>
                </div>
            </div>
            <div class="mux-form-line">
                <div class="mux-line-header"><div class="title">{{ t('mux.settings.railWidth') }}</div></div>
                <div class="mux-line-control">
                    <input type="number" class="form-control" id="mux-rail-width" min="80" max="400"
                           [(ngModel)]="settings.sidebar.width" (ngModelChange)="save()">
                </div>
            </div>
        </ng-container>

        <ng-container *ngIf="tab === 'sessions'">
            <div class="mux-form-line">
                <div class="mux-line-header"><div class="title">{{ t('mux.settings.isolated') }}</div></div>
                <div class="mux-line-control">
                    <div class="form-check form-switch">
                        <input type="checkbox" class="form-check-input" id="mux-isolated"
                               [(ngModel)]="settings.isolatedSessions" (ngModelChange)="save()">
                    </div>
                </div>
            </div>
            <div class="mux-form-line">
                <div class="mux-line-header"><div class="title">{{ t('mux.settings.autoAdopt') }}</div></div>
                <div class="mux-line-control">
                    <div class="form-check form-switch">
                        <input type="checkbox" class="form-check-input" id="mux-adopt"
                               [(ngModel)]="settings.autoAdoptWindows" (ngModelChange)="save()">
                    </div>
                </div>
            </div>
            <div class="mux-form-line">
                <div class="mux-line-header"><div class="title">{{ t('mux.settings.defaultName') }}</div></div>
                <div class="mux-line-control">
                    <input type="text" class="form-control" id="mux-default-name" maxlength="40"
                           [ngModel]="settings.defaultSessionName ?? ''"
                           (ngModelChange)="settings.defaultSessionName = $event || null; save()">
                </div>
            </div>
            <div class="mux-form-line">
                <div class="mux-line-header"><div class="title">{{ t('mux.settings.profile') }}</div></div>
                <div class="mux-line-control">
                    <select class="form-select" id="mux-profile"
                            [ngModel]="settings.newWindowProfile ?? ''"
                            (ngModelChange)="settings.newWindowProfile = $event || null; save()">
                        <option value="">{{ t('mux.settings.profileAuto') }}</option>
                        <option *ngFor="let p of profiles" [ngValue]="p.id">{{ p.name }} ({{ p.type }})</option>
                    </select>
                </div>
            </div>
        </ng-container>

        <ng-container *ngIf="tab === 'templates'">
            <div class="mb-3">
                <button type="button" class="btn btn-primary btn-sm"
                        [disabled]="!mux.sessions.length"
                        (click)="saveTemplate()">
                    <i class="fas fa-bookmark me-1"></i>{{ t('mux.settings.tplSave') }}
                </button>
            </div>
            <div *ngIf="!templates.length" class="mux-tpl-empty">{{ t('mux.settings.tplEmpty') }}</div>
            <div *ngFor="let tpl of templates" class="mux-tpl-row">
                <i class="fas fa-layer-group"></i>
                <span class="mux-tpl-name">{{ tpl.name }}</span>
                <span class="mux-tpl-meta">{{ t('mux.settings.tplWindows', { n: tpl.windows.length }) }}
                    · {{ tpl.createdAt | date:'short' }}</span>
                <div class="ms-auto d-flex gap-2">
                    <button type="button" class="btn btn-sm btn-primary"
                            (click)="applyTemplate(tpl)">
                        <i class="fas fa-play me-1"></i>{{ t('mux.tmpl.apply') }}
                    </button>
                    <button type="button" class="btn btn-sm btn-outline-danger"
                            (click)="deleteTemplate(tpl)">
                        <i class="fas fa-trash-alt me-1"></i>{{ t('mux.tmpl.delete') }}
                    </button>
                </div>
            </div>
        </ng-container>
    `,
})
export class MuxSettingsComponent implements OnInit, OnDestroy {
    tab = 'statusbar'
    settings: any
    profiles: any[] = []
    private changedSub: Subscription | null = null

    constructor (
        private config: ConfigService,
        private profilesService: ProfilesService,
        private i18n: I18n,
        private mux: MuxService,
        private cdr: ChangeDetectorRef,
    ) { }

    ngOnInit (): void {
        this.settings = this.config.store[CONFIG_KEY]
        void this.profilesService.getProfiles().then(list => {
            this.profiles = list
        })
        // A save from the prompt modal or another surface (rail context menu,
        // palette) must show up here immediately.
        this.changedSub = this.mux.changed$.subscribe(() => this.cdr.detectChanges())
    }

    ngOnDestroy (): void {
        this.changedSub?.unsubscribe()
    }

    get templates (): MuxSessionTemplate[] {
        return this.mux.templates
    }

    t (key: string, params?: Record<string, any>): string {
        return this.i18n.t(key, params)
    }

    save (): void {
        void this.config.save()
    }

    saveTemplate (): void {
        void this.mux.saveSessionAsTemplatePrompt(this.mux.activeSession)
    }

    applyTemplate (tpl: MuxSessionTemplate): void {
        void this.mux.createSessionFromTemplate(tpl)
    }

    deleteTemplate (tpl: MuxSessionTemplate): void {
        void this.mux.deleteTemplate(tpl)
    }
}
