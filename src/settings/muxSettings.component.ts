import { CdkDragDrop, moveItemInArray } from '@angular/cdk/drag-drop'
import { ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core'
import { ConfigService, PlatformService, ProfilesService } from 'tabby-core'
import { Subscription } from 'rxjs'
import { I18n } from '../i18n'
import { CONFIG_KEY } from '../configKeys'
import { MuxService } from '../mux.service'
import { MuxSessionTemplate } from '../types'
import {
    appendPane,
    deepClone,
    deletePane,
    duplicatePane,
    getRootOrientation,
    setRootOrientation,
    windowPanes,
    windowSummary,
} from '../template.model'

/**
 * Settings page for tabby-mux, organized in tabs. Values bind straight onto
 * the config proxy (declared in MuxConfigProvider defaults, so writes
 * persist); every change saves immediately. Row structure mirrors the
 * native settings pages, with self-contained styling since the native
 * classes are scoped to their components.
 *
 * The templates tab has two modes: the list, and an in-place editor working
 * on a deep-cloned copy of one template (structural edits mutate recovery
 * token trees via template.model helpers) with explicit save / discard /
 * preview-apply.
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
            flex-wrap: wrap;
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
        .mux-drag-handle {
            cursor: grab;
            color: var(--theme-fg-more-2, #666);
            padding: 0 2px;
        }
        .mux-edit-window.cdk-drag-preview, .mux-edit-window.cdk-drag-placeholder { opacity: .6; }
        .mux-edit-window { border-radius: 5px; }
        .mux-edit-panes {
            flex-basis: 100%;
            border-top: 1px dashed var(--theme-bg-less, rgba(128, 128, 128, .25));
            margin-top: 6px;
            padding-top: 6px;
        }
        .mux-edit-pane {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 4px 6px;
            margin: 2px 0;
            border-radius: 4px;
            background: var(--theme-bg-less, rgba(128, 128, 128, .1));
            font-size: 12px;
        }
        .mux-edit-pane .mux-pane-meta {
            color: var(--theme-fg-more, #999);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .mux-edit-unsaved {
            color: var(--theme-warning, #f0ad4e);
            font-size: 12px;
        }
        .mux-btn-sq { padding: 2px 8px; }
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

        <ng-container *ngIf="tab === 'templates' && !editing">
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
                    <button type="button" class="btn btn-sm btn-primary" (click)="applyTemplate(tpl)">
                        <i class="fas fa-play me-1"></i>{{ t('mux.tmpl.apply') }}
                    </button>
                    <button type="button" class="btn btn-sm btn-secondary" (click)="startEdit(tpl)">
                        <i class="fas fa-pencil-alt me-1"></i>{{ t('mux.edit.short') }}
                    </button>
                    <button type="button" class="btn btn-sm btn-outline-danger" (click)="deleteTemplate(tpl)">
                        <i class="fas fa-trash-alt me-1"></i>{{ t('mux.tmpl.delete') }}
                    </button>
                </div>
            </div>
        </ng-container>

        <ng-container *ngIf="tab === 'templates' && editing">
            <div class="d-flex align-items-center gap-2 flex-wrap mb-3">
                <button type="button" class="btn btn-sm btn-secondary" (click)="backFromEditor()">
                    <i class="fas fa-arrow-left"></i>
                </button>
                <input type="text" class="form-control" style="width: 240px"
                       [placeholder]="t('mux.edit.name')" maxlength="60"
                       [(ngModel)]="editing.name" (ngModelChange)="dirty = true">
                <span *ngIf="dirty" class="mux-edit-unsaved">{{ t('mux.edit.unsaved') }}</span>
                <div class="ms-auto d-flex gap-2">
                    <button type="button" class="btn btn-sm btn-secondary" (click)="previewEdit()">
                        <i class="fas fa-flask me-1"></i>{{ t('mux.edit.preview') }}
                    </button>
                    <button type="button" class="btn btn-sm btn-outline-danger" [disabled]="!dirty" (click)="discardEdit()">
                        {{ t('mux.edit.discard') }}
                    </button>
                    <button type="button" class="btn btn-sm btn-primary" [disabled]="!dirty" (click)="saveEdit()">
                        <i class="fas fa-check me-1"></i>{{ t('mux.edit.save') }}
                    </button>
                </div>
            </div>

            <div class="mux-tpl-meta mb-1">{{ t('mux.edit.windows') }}</div>
            <div cdkDropList (cdkDropListDropped)="windowDropped($event)">
                <div *ngFor="let w of editing.windows; let i = index" class="mux-tpl-row mux-edit-window" cdkDrag>
                    <i class="fas fa-grip-vertical mux-drag-handle" cdkDragHandle title="⇕"></i>
                    <span class="mux-tpl-name">{{ t('mux.edit.window', { n: i + 1 }) }}</span>
                    <span class="mux-tpl-meta">
                        {{ t('mux.edit.panes', { n: paneCount(w) }) }} · {{ summary(w).profile }}
                    </span>
                    <div class="ms-auto d-flex gap-1">
                        <button type="button" class="btn btn-sm btn-outline-secondary mux-btn-sq"
                                [disabled]="i === 0" [title]="t('mux.edit.up')" (click)="moveWindow(i, -1)">↑</button>
                        <button type="button" class="btn btn-sm btn-outline-secondary mux-btn-sq"
                                [disabled]="i === editing.windows.length - 1" [title]="t('mux.edit.down')" (click)="moveWindow(i, 1)">↓</button>
                        <button type="button" class="btn btn-sm btn-outline-secondary mux-btn-sq"
                                [title]="t('mux.edit.duplicate')" (click)="duplicateWindow(i)">
                            <i class="fas fa-copy"></i></button>
                        <button type="button" class="btn btn-sm btn-outline-danger mux-btn-sq"
                                [title]="t('mux.edit.remove')" (click)="removeWindow(i)">
                            <i class="fas fa-trash-alt"></i></button>
                        <button type="button" class="btn btn-sm btn-outline-secondary mux-btn-sq"
                                (click)="expanded = expanded === i ? null : i">
                            <ng-container *ngIf="expanded !== i">{{ t('mux.edit.expand') }} ▾</ng-container>
                            <ng-container *ngIf="expanded === i">{{ t('mux.edit.collapse') }} ▴</ng-container>
                        </button>
                    </div>

                    <div *ngIf="expanded === i" class="mux-edit-panes">
                        <div class="d-flex align-items-center gap-2 mb-2">
                            <span class="mux-tpl-meta">{{ t('mux.edit.orientation') }}:</span>
                            <div class="btn-group btn-group-sm">
                                <button type="button" class="btn"
                                        [class.btn-primary]="orientation(w) === 'h'"
                                        [class.btn-outline-secondary]="orientation(w) !== 'h'"
                                        (click)="setOrientation(w, 'h')">{{ t('mux.edit.horizontal') }}</button>
                                <button type="button" class="btn"
                                        [class.btn-primary]="orientation(w) === 'v'"
                                        [class.btn-outline-secondary]="orientation(w) !== 'v'"
                                        (click)="setOrientation(w, 'v')">{{ t('mux.edit.vertical') }}</button>
                            </div>
                        </div>
                        <div *ngFor="let p of paneList(w)" class="mux-edit-pane">
                            <i class="fas fa-terminal"></i>
                            <strong>{{ p.profileName }}</strong>
                            <span class="mux-pane-meta">
                                {{ p.type.replace('app:', '') }}<ng-container *ngIf="p.cwd"> · {{ p.cwd }}</ng-container>
                            </span>
                            <div class="ms-auto d-flex gap-1">
                                <button type="button" class="btn btn-sm btn-outline-secondary mux-btn-sq"
                                        [title]="t('mux.edit.duplicate')" (click)="dupPane(w, p.index)">
                                    <i class="fas fa-copy"></i></button>
                                <button type="button" class="btn btn-sm btn-outline-danger mux-btn-sq"
                                        [title]="t('mux.edit.remove')" (click)="delPane(w, p.index)">
                                    <i class="fas fa-trash-alt"></i></button>
                            </div>
                        </div>
                        <div class="d-flex align-items-center gap-2 mt-2">
                            <select class="form-select form-select-sm" style="width: 220px"
                                    [(ngModel)]="appendProfileId">
                                <option value="">{{ t('mux.settings.profile') }}…</option>
                                <option *ngFor="let p of profiles" [ngValue]="p.id">{{ p.name }} ({{ p.type }})</option>
                            </select>
                            <button type="button" class="btn btn-sm btn-outline-secondary"
                                    [disabled]="!appendProfileId" (click)="appendBlankPane(w)">
                                <i class="fas fa-plus me-1"></i>{{ t('mux.edit.appendPane') }}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
            <div *ngIf="!editing.windows.length" class="mux-tpl-empty">{{ t('mux.edit.noWindows') }}</div>

            <div class="d-flex align-items-center gap-2 flex-wrap mt-3">
                <select class="form-select form-select-sm" style="width: 260px"
                        [(ngModel)]="importWindowKey">
                    <option value="">{{ t('mux.edit.importWindow') }}…</option>
                    <option *ngFor="let opt of importableWindows" [ngValue]="opt.key">
                        {{ opt.label }}
                    </option>
                </select>
                <button type="button" class="btn btn-sm btn-outline-secondary"
                        [disabled]="!importWindowKey" (click)="importWindow()">
                    <i class="fas fa-download me-1"></i>{{ t('mux.edit.importWindow') }}
                </button>
                <select class="form-select form-select-sm" style="width: 220px"
                        [(ngModel)]="blankProfileId">
                    <option value="">{{ t('mux.edit.addBlankWindow') }}…</option>
                    <option *ngFor="let p of profiles" [ngValue]="p.id">{{ p.name }} ({{ p.type }})</option>
                </select>
                <button type="button" class="btn btn-sm btn-outline-secondary"
                        [disabled]="!blankProfileId" (click)="addBlankWindow()">
                    <i class="fas fa-plus me-1"></i>
                </button>
            </div>
        </ng-container>
    `,
})
export class MuxSettingsComponent implements OnInit, OnDestroy {
    tab = 'statusbar'
    settings: any
    profiles: any[] = []
    private changedSub: Subscription | null = null

    // ---- template editor state ----
    editing: (MuxSessionTemplate & { windows: any[] }) | null = null
    dirty = false
    expanded: number | null = null
    appendProfileId = ''
    blankProfileId = ''
    importWindowKey = ''

    constructor (
        private config: ConfigService,
        private profilesService: ProfilesService,
        private i18n: I18n,
        private mux: MuxService,
        private platform: PlatformService,
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
        // Debug handle for CDP-based verification (mirrors window.tabbyMux).
        const w = window as any
        w.__muxSettingsComponent = this
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

    // ==================================================================
    // Template editor
    // ==================================================================

    startEdit (tpl: MuxSessionTemplate): void {
        const copy = deepClone(tpl) as any
        // Self-heal legacy templates saved before empty windows were pruned.
        copy.windows = copy.windows.filter((w: any) => windowPanes(w).length > 0)
        this.editing = copy
        this.dirty = false
        this.expanded = null
        this.appendProfileId = ''
        this.blankProfileId = ''
        this.importWindowKey = ''
    }

    backFromEditor (): void {
        if (this.dirty) {
            void this.confirmDiscard()
            return
        }
        this.editing = null
    }

    private async confirmDiscard (): Promise<void> {
        const result = await this.platform.showMessageBox({
            type: 'warning',
            message: this.t('mux.edit.unsaved'),
            detail: this.t('mux.edit.discard') + '?',
            buttons: [this.t('mux.edit.keepEditing'), this.t('mux.edit.discard')],
            defaultId: 0,
            cancelId: 0,
        })
        if (result.response === 1) {
            this.editing = null
            this.dirty = false
        }
    }

    discardEdit (): void {
        if (this.editing) {
            this.startEdit(this.templates.find(x => x.id === this.editing!.id) ?? this.editing!)
        }
    }

    saveEdit (): void {
        if (!this.editing) {
            return
        }
        this.editing.name = this.editing.name.trim() || this.editing.name
        void this.mux.saveTemplateEdit(deepClone(this.editing) as any)
        this.dirty = false
    }

    previewEdit (): void {
        if (!this.editing) {
            return
        }
        void this.mux.createSessionFromTemplate(deepClone(this.editing) as any)
    }

    windowDropped (event: CdkDragDrop<string[]>): void {
        if (event.previousIndex === event.currentIndex || !this.editing) {
            return
        }
        moveItemInArray(this.editing.windows, event.previousIndex, event.currentIndex)
        if (this.expanded === event.previousIndex) {
            this.expanded = event.currentIndex
        }
        this.dirty = true
    }

    moveWindow (index: number, delta: number): void {
        if (!this.editing) {
            return
        }
        const target = index + delta
        if (target < 0 || target >= this.editing.windows.length) {
            return
        }
        const [w] = this.editing.windows.splice(index, 1)
        this.editing.windows.splice(target, 0, w)
        if (this.expanded === index) {
            this.expanded = target
        }
        this.dirty = true
    }

    duplicateWindow (index: number): void {
        if (!this.editing) {
            return
        }
        this.editing.windows.splice(index + 1, 0, deepClone(this.editing.windows[index]))
        this.dirty = true
    }

    removeWindow (index: number): void {
        if (!this.editing) {
            return
        }
        this.editing.windows.splice(index, 1)
        if (this.expanded === index) {
            this.expanded = null
        } else if (this.expanded !== null && this.expanded > index) {
            this.expanded--
        }
        this.dirty = true
    }

    // ---- pane level ----

    paneCount (windowToken: any): number {
        return windowSummary(windowToken).panes
    }

    summary (windowToken: any): { panes: number, profile: string } {
        return windowSummary(windowToken)
    }

    paneList (windowToken: any): any[] {
        return windowPanes(windowToken)
    }

    orientation (windowToken: any): 'h' | 'v' {
        return getRootOrientation(windowToken)
    }

    setOrientation (windowToken: any, orientation: 'h' | 'v'): void {
        if (getRootOrientation(windowToken) === orientation) {
            return
        }
        setRootOrientation(windowToken, orientation)
        this.dirty = true
    }

    dupPane (windowToken: any, flatIndex: number): void {
        duplicatePane(windowToken, flatIndex)
        this.dirty = true
    }

    delPane (windowToken: any, flatIndex: number): void {
        deletePane(windowToken, flatIndex)
        // Deleting the last pane empties the window - drop it instead of
        // keeping a token that would restore a broken window.
        const idx = this.editing?.windows.indexOf(windowToken) ?? -1
        if (idx !== -1 && windowPanes(windowToken).length === 0) {
            this.removeWindow(idx)
            return
        }
        this.dirty = true
    }

    appendBlankPane (windowToken: any): void {
        const profile = this.profiles.find(p => p.id === this.appendProfileId)
        if (!profile) {
            return
        }
        appendPane(windowToken, profile)
        this.dirty = true
    }

    get importableWindows (): { key: string, label: string }[] {
        const out: { key: string, label: string }[] = []
        for (const session of this.mux.sessions) {
            session.windows.forEach((win, i) => {
                out.push({
                    key: `${win.id}`,
                    label: `${session.name} · ${this.t('mux.edit.window', { n: i + 1 })}`,
                })
            })
        }
        return out
    }

    async importWindow (): Promise<void> {
        if (!this.editing || !this.importWindowKey) {
            return
        }
        const win = this.mux.sessions.flatMap(s => s.windows).find(w => w.id === this.importWindowKey)
        if (!win) {
            return
        }
        const token = await this.mux.windowToken(win)
        if (token) {
            this.editing.windows.push(token)
            this.dirty = true
        }
        this.importWindowKey = ''
    }

    addBlankWindow (): void {
        const profile = this.profiles.find(p => p.id === this.blankProfileId)
        if (!profile || !this.editing) {
            return
        }
        const container = { type: 'app:split-tab', ratios: [1], orientation: 'h', children: [] }
        appendPane(container, profile)
        this.editing.windows.push(container)
        this.dirty = true
    }
}
