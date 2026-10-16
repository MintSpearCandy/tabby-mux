import { CdkDragDrop, moveItemInArray } from '@angular/cdk/drag-drop'
import { ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core'
import { ConfigService, PlatformService, ProfilesService } from 'tabby-core'
import { Subscription } from 'rxjs'
import { I18n } from '../i18n'
import { CONFIG_KEY } from '../configKeys'
import { MuxService } from '../mux.service'
import { isLayoutContainer, MuxLayoutContainer, MuxPaneSpec, MuxSessionTemplate } from '../types'
import {
    deepClone,
    deleteSpecAt,
    duplicateSpecAt,
    nodeAtPath,
    specPaneAt,
    specPanes,
    specSummary,
    splitSpecAt,
} from '../template.model'

/**
 * Settings page for tabby-mux, organized in tabs. Row structure mirrors the
 * native settings pages, with self-contained styling.
 *
 * The templates tab has two modes: the list, and an in-place editor working
 * on a deep-cloned copy of one template. Each window is edited through a
 * graphical layout canvas (nested flex rendering with real ratios - what
 * you see is the actual layout); panes are selected by click and can be
 * split/duplicated/deleted, their profile switched as a live reference, or
 * forked into an embedded editable copy which can be promoted back into a
 * new Tabby profile.
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
        .mux-edit-unsaved {
            color: var(--theme-warning, #f0ad4e);
            font-size: 12px;
        }
        .mux-btn-sq { padding: 2px 8px; }
        /* ---- graphical layout canvas ---- */
        .mux-canvas {
            flex-basis: 100%;
            height: 220px;
            display: flex;
            margin-top: 6px;
            padding: 4px;
            border: 1px solid var(--theme-bg-less, rgba(128, 128, 128, .3));
            border-radius: 6px;
            background: var(--theme-bg, #1e1e1e);
        }
        .mux-node { display: flex; width: 100%; height: 100%; min-width: 0; min-height: 0; gap: 3px; }
        .mux-node.mux-h { flex-direction: row; }
        .mux-node.mux-v { flex-direction: column; }
        .mux-cell { display: flex; flex-basis: 0; min-width: 0; min-height: 0; }
        .mux-gpane {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 3px;
            border: 1px solid var(--theme-bg-less, rgba(128, 128, 128, .35));
            border-radius: 5px;
            background: var(--theme-bg-more, rgba(128, 128, 128, .1));
            cursor: pointer;
            overflow: hidden;
            padding: 4px;
            text-align: center;
            font-size: 12px;
            color: var(--theme-fg, #ccc);
        }
        .mux-gpane:hover { border-color: var(--theme-primary, #0d6efd); }
        .mux-gpane.selected {
            border-color: var(--theme-primary, #0d6efd);
            background: color-mix(in srgb, var(--theme-primary, #0d6efd) 18%, transparent);
        }
        .mux-gpane .mux-gname {
            max-width: 100%;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .mux-badge {
            font-size: 10px;
            padding: 1px 6px;
            border-radius: 8px;
            background: var(--theme-bg-less, rgba(128, 128, 128, .3));
            color: var(--theme-fg-more, #999);
        }
        .mux-badge.copy { background: var(--theme-warning, #f0ad4e); color: #000; }
        .mux-sel-panel {
            flex-basis: 100%;
            border-top: 1px dashed var(--theme-bg-less, rgba(128, 128, 128, .25));
            margin-top: 6px;
            padding-top: 8px;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .mux-inline-field {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 12px;
        }
        .mux-inline-field label { width: 90px; color: var(--theme-fg-more, #999); flex-shrink: 0; }
        .mux-inline-field input { max-width: 320px; }
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

                    <div *ngIf="expanded === i" class="mux-canvas" (click)="$event.stopPropagation()">
                        <ng-container *ngTemplateOutlet="nodeTpl; context: {$implicit: w.layout, path: []}"></ng-container>
                    </div>
                    <div *ngIf="expanded === i && !selectedPath" class="mux-sel-panel">
                        <span class="mux-tpl-meta">{{ t('mux.ge.selectHint') }}</span>
                    </div>
                    <div *ngIf="expanded === i && selectedPath && selectedPaneSpec as p" class="mux-sel-panel">
                        <div class="d-flex align-items-center gap-2 flex-wrap">
                            <i class="fas fa-terminal"></i>
                            <strong>{{ selectedPaneInfo.profileName }}</strong>
                            <span class="mux-badge" [class.copy]="!p.profileId">
                                {{ p.profileId ? t('mux.ge.ref') : t('mux.ge.copy') }}
                            </span>
                            <div class="ms-auto d-flex gap-1">
                                <button type="button" class="btn btn-sm btn-outline-secondary mux-btn-sq"
                                        (click)="splitSelected('h')"><i class="fas fa-columns me-1"></i>{{ t('mux.ge.splitH') }}</button>
                                <button type="button" class="btn btn-sm btn-outline-secondary mux-btn-sq"
                                        (click)="splitSelected('v')"><i class="fas fa-rows me-1"></i>{{ t('mux.ge.splitV') }}</button>
                                <button type="button" class="btn btn-sm btn-outline-secondary mux-btn-sq"
                                        [title]="t('mux.edit.duplicate')" (click)="duplicateSelected()">
                                    <i class="fas fa-copy"></i></button>
                                <button type="button" class="btn btn-sm btn-outline-danger mux-btn-sq"
                                        [title]="t('mux.edit.remove')" (click)="deleteSelected()">
                                    <i class="fas fa-trash-alt"></i></button>
                            </div>
                        </div>

                        <div class="mux-inline-field">
                            <label>{{ t('mux.settings.profile') }}</label>
                            <select class="form-select form-select-sm" style="width: 260px"
                                    [ngModel]="p.profileId ?? ''"
                                    (ngModelChange)="switchReference($event)">
                                <option *ngFor="let pr of profiles" [ngValue]="pr.id">{{ pr.name }} ({{ pr.type }})</option>
                            </select>
                            <button *ngIf="p.profileId" type="button" class="btn btn-sm btn-outline-secondary"
                                    (click)="forkSelected()">{{ t('mux.ge.fork') }}</button>
                        </div>

                        <ng-container *ngIf="!p.profileId">
                            <div class="mux-inline-field">
                                <label>{{ t('mux.ge.paneName') }}</label>
                                <input type="text" class="form-control form-control-sm" style="width: 260px"
                                       [(ngModel)]="p.profile.name" (ngModelChange)="dirty = true">
                            </div>
                            <div class="mux-inline-field" *ngIf="p.profile.type === 'local'">
                                <label>{{ t('mux.ge.command') }}</label>
                                <input type="text" class="form-control form-control-sm" style="width: 320px"
                                       [(ngModel)]="p.profile.options.command" (ngModelChange)="dirty = true">
                            </div>
                            <div class="mux-inline-field" *ngIf="p.profile.type === 'local'">
                                <label>{{ t('mux.ge.cwd') }}</label>
                                <input type="text" class="form-control form-control-sm" style="width: 320px"
                                       [(ngModel)]="p.profile.options.cwd" (ngModelChange)="dirty = true">
                            </div>
                            <div class="mux-inline-field">
                                <label>{{ t('mux.ge.promote') }}</label>
                                <input type="text" class="form-control form-control-sm" style="width: 200px"
                                       [placeholder]="t('mux.ge.promoteName')" maxlength="60" [(ngModel)]="promoteName">
                                <button type="button" class="btn btn-sm btn-outline-primary"
                                        [disabled]="!promoteName.trim()" (click)="promoteSelected()">
                                    <i class="fas fa-upload me-1"></i>{{ t('mux.ge.promote') }}
                                </button>
                            </div>
                        </ng-container>
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

        <ng-template #nodeTpl let-node let-path="path">
            <ng-container *ngIf="isContainer(node)">
                <div class="mux-node" [class.mux-h]="node.orientation === 'h'" [class.mux-v]="node.orientation === 'v'">
                    <div *ngFor="let child of node.children; let i = index"
                         class="mux-cell" [style.flex-grow]="node.ratios[i] || 1">
                        <ng-container *ngTemplateOutlet="nodeTpl; context: {$implicit: child, path: path.concat(i)}"></ng-container>
                    </div>
                </div>
            </ng-container>
            <div *ngIf="!isContainer(node)" class="mux-gpane"
                 [class.selected]="isSelected(path)" (click)="selectPane($event, path)">
                <i class="fas fa-terminal"></i>
                <span class="mux-gname">{{ paneLabel(node.pane) }}</span>
                <span class="mux-badge" [class.copy]="!node.pane.profileId">
                    {{ node.pane.profileId ? t('mux.ge.ref') : t('mux.ge.copy') }}
                </span>
            </div>
        </ng-template>
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
    selectedPath: number[] | null = null
    promoteName = ''
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
    // Template editor: windows
    // ==================================================================

    startEdit (tpl: MuxSessionTemplate): void {
        const copy = deepClone(tpl) as any
        // Self-heal: drop windows without panes.
        copy.windows = (copy.windows ?? []).filter((w: any) => this.paneCount(w) > 0)
        this.editing = copy
        this.dirty = false
        this.expanded = null
        this.selectedPath = null
        this.promoteName = ''
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
            this.selectedPath = null
        } else if (this.expanded !== null && this.expanded > index) {
            this.expanded--
        }
        this.dirty = true
    }

    paneCount (windowSpec: any): number {
        return specSummary(windowSpec).panes
    }

    summary (windowSpec: any): { panes: number, profile: string } {
        return specSummary(windowSpec)
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
        const spec = await this.mux.captureWindowSpec(win)
        if (spec) {
            this.editing.windows.push(spec)
            this.dirty = true
        }
        this.importWindowKey = ''
    }

    addBlankWindow (): void {
        const profile = this.profiles.find(p => p.id === this.blankProfileId)
        if (!profile || !this.editing) {
            return
        }
        this.editing.windows.push({
            layout: {
                orientation: 'h',
                ratios: [1],
                children: [{ pane: { profileId: profile.id, profile: null } }],
            },
        })
        this.dirty = true
    }

    // ==================================================================
    // Template editor: graphical layout canvas
    // ==================================================================

    isContainer (node: any): boolean {
        return isLayoutContainer(node)
    }

    isSelected (path: number[]): boolean {
        return !!this.selectedPath && this.selectedPath.join('.') === path.join('.')
    }

    paneLabel (pane: MuxPaneSpec): string {
        return pane.profile?.name ?? pane.profileId ?? '?'
    }

    selectPane (event: MouseEvent, path: number[]): void {
        event.stopPropagation()
        this.selectedPath = [...path]
        this.promoteName = ''
    }

    get selectedLayout (): MuxLayoutContainer | null {
        if (!this.editing || this.expanded === null) {
            return null
        }
        return this.editing.windows[this.expanded]?.layout ?? null
    }

    get selectedPaneSpec (): MuxPaneSpec | null {
        const layout = this.selectedLayout
        return layout && this.selectedPath ? specPaneAt(layout, this.selectedPath) : null
    }

    get selectedPaneInfo () {
        const layout = this.selectedLayout
        if (!layout || !this.selectedPath) {
            return { profileName: '?' }
        }
        const info = specPanes(layout).find(p => p.path.join('.') === this.selectedPath!.join('.'))
        return info ?? { profileName: '?' }
    }

    /** Default pane for split ops: reference to the first local profile. */
    private defaultPaneSpec (): MuxPaneSpec {
        const preferred = this.profiles.find(p => p.type === 'local')
        return { profileId: preferred?.id ?? this.profiles[0]?.id ?? null, profile: null }
    }

    splitSelected (direction: 'h' | 'v'): void {
        const layout = this.selectedLayout
        const pane = this.selectedPaneSpec
        if (!layout || !this.selectedPath || !pane) {
            return
        }
        splitSpecAt(layout, this.selectedPath, direction, this.defaultPaneSpec())
        // normalizeSpec may hoist containers and shift indexes - recover
        // the selection through pane identity (captured BEFORE mutating).
        this.selectedPath = findPathByPane(layout, pane)
        this.dirty = true
    }

    duplicateSelected (): void {
        const layout = this.selectedLayout
        const pane = this.selectedPaneSpec
        if (!layout || !this.selectedPath || !pane) {
            return
        }
        duplicateSpecAt(layout, this.selectedPath)
        this.selectedPath = findPathByPane(layout, pane)
        this.dirty = true
    }

    deleteSelected (): void {
        const layout = this.selectedLayout
        if (!layout || !this.selectedPath || !this.editing || this.expanded === null) {
            return
        }
        // Deleting the last pane empties the window - drop it instead of
        // keeping a spec that would restore a broken window.
        if (specPanes(layout).length <= 1) {
            this.removeWindow(this.expanded)
            return
        }
        deleteSpecAt(layout, this.selectedPath)
        this.selectedPath = null
        this.dirty = true
    }

    switchReference (profileId: string): void {
        const pane = this.selectedPaneSpec
        if (!pane) {
            return
        }
        pane.profileId = profileId || null
        pane.profile = null
        this.dirty = true
    }

    /** Forks the referenced profile into an embedded editable copy. */
    forkSelected (): void {
        const pane = this.selectedPaneSpec
        if (!pane || !pane.profileId) {
            return
        }
        const registryProfile = this.profiles.find(p => p.id === pane.profileId)
        pane.profile = deepClone(registryProfile ?? { name: pane.profileId, options: {} })
        delete pane.profile.icon
        pane.profileId = null
        this.dirty = true
    }

    async promoteSelected (): Promise<void> {
        const pane = this.selectedPaneSpec
        if (!pane || !pane.profile) {
            return
        }
        await this.mux.promotePaneProfile(pane, this.promoteName)
        this.promoteName = ''
        // refresh the profiles dropdown with the newly created profile
        this.profiles = await this.profilesService.getProfiles()
        this.dirty = true
    }
}

function findPathByPane (root: MuxLayoutContainer, pane: MuxPaneSpec): number[] | null {
    const walk = (node: any, path: number[]): number[] | null => {
        if (!node || !Array.isArray(node.children)) {
            return node?.pane === pane ? path : null
        }
        for (let i = 0; i < node.children.length; i++) {
            const found = walk(node.children[i], [...path, i])
            if (found) {
                return found
            }
        }
        return null
    }
    return walk(root, [])
}
