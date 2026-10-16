import { CdkDragDrop, moveItemInArray } from '@angular/cdk/drag-drop'
import { ChangeDetectorRef, Component, OnDestroy, OnInit, TemplateRef, ViewChild } from '@angular/core'
import { ConfigService, MenuItemOptions, PlatformService, ProfilesService } from 'tabby-core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { Subscription } from 'rxjs'
import { I18n } from '../i18n'
import { CONFIG_KEY } from '../configKeys'
import { MuxService } from '../mux.service'
import { isLayoutContainer, MuxLayoutContainer, MuxPaneSpec, MuxSessionTemplate } from '../types'
import {
    deepClone,
    deleteSpecAt,
    duplicateSpecAt,
    specPaneAt,
    specPanes,
    specSummary,
    splitSpecAt,
} from '../template.model'

/**
 * Settings page for tabby-mux: "Templates" first (profiles-page-style
 * grouped list; click a row to edit in a floating modal), everything else
 * merged into a single "General" tab.
 *
 * The template editor modal shows the window list plus a graphical layout
 * canvas: panes are click-selected, right-clicked for structural actions,
 * and carry a borderless corner edit button that opens the pane's config in
 * its own modal. Saving pane edits stores an independent copy with the
 * template; writing back to the global profile registry is an explicit
 * "Save as profile & connection" action. Divider handles between panes are
 * draggable to adjust ratios.
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
        .mux-form-line .mux-line-control { width: 220px; flex-shrink: 0; }
        .mux-form-line .form-check { margin: 0; }
        .mux-section-title {
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: .5px;
            color: var(--theme-fg-more, #999);
            margin: 18px 0 6px;
        }
        .mux-section-title:first-child { margin-top: 0; }
        /* ---- profiles-page-style template list ---- */
        .mux-group-header {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 8px 6px 4px;
            font-size: 12px;
            font-weight: 600;
            color: var(--theme-fg-more, #999);
        }
        .mux-tpl-entry {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 7px 10px;
            margin: 2px 0;
            border-radius: 6px;
            cursor: pointer;
        }
        .mux-tpl-entry:hover { background: var(--theme-bg-less, rgba(128, 128, 128, .18)); }
        .mux-tpl-entry .mux-entry-icon { color: var(--theme-fg-more, #999); }
        .mux-tpl-entry .mux-entry-text { flex: 1; min-width: 0; }
        .mux-tpl-entry .mux-entry-name { font-size: 13px; }
        .mux-tpl-entry .mux-entry-meta {
            font-size: 11px;
            color: var(--theme-fg-more, #999);
        }
        .mux-icon-btn {
            border: none;
            background: transparent;
            color: var(--theme-fg-more, #999);
            padding: 4px 7px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
        }
        .mux-icon-btn:hover {
            background: var(--theme-bg-less, rgba(128, 128, 128, .3));
            color: var(--theme-fg, #ccc);
        }
        .mux-tpl-empty {
            padding: 16px 0;
            font-size: 13px;
            color: var(--theme-fg-more, #999);
        }
        /* ---- editor modal ---- */
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
            height: 240px;
            display: flex;
            margin-top: 6px;
            padding: 4px;
            border: 1px solid var(--theme-bg-less, rgba(128, 128, 128, .3));
            border-radius: 6px;
            background: var(--theme-bg, #1e1e1e);
        }
        .mux-node { display: flex; width: 100%; height: 100%; min-width: 0; min-height: 0; }
        .mux-node.mux-h { flex-direction: row; }
        .mux-node.mux-v { flex-direction: column; }
        .mux-cell { display: flex; flex-basis: 0; min-width: 0; min-height: 0; }
        .mux-divider { flex: 0 0 6px; z-index: 5; }
        .mux-node.mux-h > .mux-divider { cursor: col-resize; }
        .mux-node.mux-v > .mux-divider { cursor: row-resize; }
        .mux-divider::after {
            content: '';
            display: block;
            width: 2px;
            height: 100%;
            margin: 0 auto;
            border-radius: 2px;
            background: var(--theme-bg-less, rgba(128, 128, 128, .3));
        }
        .mux-node.mux-v > .mux-divider::after { width: 100%; height: 2px; margin: auto 0; }
        .mux-divider:hover::after, .mux-divider.dragging::after {
            background: var(--theme-primary, #0d6efd);
        }
        .mux-gpane {
            position: relative;
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
        .mux-pane-edit {
            position: absolute;
            right: 3px;
            bottom: 3px;
            border: none;
            background: transparent;
            color: var(--theme-fg-more, #999);
            padding: 2px 5px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 11px;
            opacity: 0;
        }
        .mux-gpane:hover .mux-pane-edit, .mux-gpane.selected .mux-pane-edit { opacity: .85; }
        .mux-pane-edit:hover { color: var(--theme-fg, #ccc); background: var(--theme-bg-less, rgba(128,128,128,.35)); }
        .mux-sel-bar {
            flex-basis: 100%;
            margin-top: 6px;
            font-size: 12px;
            color: var(--theme-fg-more, #999);
            display: flex;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
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
                    [class.is-active]="tab === 'templates'"
                    (click)="tab = 'templates'">{{ t('mux.settings.tabTemplates') }}</button>
            <button type="button" role="tab" class="mux-settings-tab"
                    [class.is-active]="tab === 'general'"
                    (click)="tab = 'general'">{{ t('mux.settings.tabGeneral') }}</button>
        </div>

        <!-- ==================== templates tab ==================== -->
        <ng-container *ngIf="tab === 'templates'">
            <div class="mb-2 d-flex">
                <button type="button" class="btn btn-primary btn-sm"
                        [disabled]="!mux.sessions.length"
                        (click)="saveTemplate()">
                    <i class="fas fa-bookmark me-1"></i>{{ t('mux.settings.tplSave') }}
                </button>
            </div>
            <div *ngIf="!templates.length" class="mux-tpl-empty">{{ t('mux.settings.tplEmpty') }}</div>
            <ng-container *ngFor="let grp of templateGroups">
                <div class="mux-group-header">
                    <i class="fas fa-folder"></i>{{ grp.name }}
                </div>
                <div *ngFor="let tpl of grp.templates" class="mux-tpl-entry" (click)="openEditor(tpl)">
                    <i class="fas fa-layer-group mux-entry-icon"></i>
                    <div class="mux-entry-text">
                        <div class="mux-entry-name">{{ tpl.name }}</div>
                        <div class="mux-entry-meta">
                            {{ t('mux.settings.tplWindows', { n: tpl.windows.length }) }} · {{ tpl.createdAt | date:'short' }}
                        </div>
                    </div>
                    <button type="button" class="mux-icon-btn"
                            [title]="t('mux.tmpl.apply')"
                            (click)="applyTemplate(tpl); $event.stopPropagation()">
                        <i class="fas fa-play"></i>
                    </button>
                    <button type="button" class="mux-icon-btn"
                            (click)="entryMenu($event, tpl); $event.stopPropagation()">
                        <i class="fas fa-ellipsis-h"></i>
                    </button>
                </div>
            </ng-container>
        </ng-container>

        <!-- ==================== general tab ==================== -->
        <ng-container *ngIf="tab === 'general'">
            <div class="mux-section-title">{{ t('mux.settings.sectionStatusbar') }}</div>
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

            <div class="mux-section-title">{{ t('mux.settings.sectionSidebar') }}</div>
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

            <div class="mux-section-title">{{ t('mux.settings.sectionSessions') }}</div>
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

        <!-- ==================== template editor modal ==================== -->
        <ng-template #editorTpl let-modal>
            <div class="modal-header">
                <h5 class="modal-title">
                    <i class="fas fa-layer-group me-2"></i>
                    <input type="text" class="form-control d-inline-block" style="width: 260px"
                           [placeholder]="t('mux.edit.name')" maxlength="60"
                           [(ngModel)]="editing.name" (ngModelChange)="dirty = true">
                </h5>
                <span *ngIf="dirty" class="mux-edit-unsaved me-2">{{ t('mux.edit.unsaved') }}</span>
                <button type="button" class="btn-close" (click)="closeEditor(false)"></button>
            </div>
            <div class="modal-body">
                <div class="mux-tpl-meta mb-1">{{ t('mux.edit.windows') }}</div>
                <div cdkDropList (cdkDropListDropped)="windowDropped($event)">
                    <div *ngFor="let w of editing.windows; let i = index" class="mux-tpl-row mux-edit-window" cdkDrag
                         (contextmenu)="windowContextMenu($event, i)">
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
                                    (click)="expanded = expanded === i ? null : i">
                                <ng-container *ngIf="expanded !== i">{{ t('mux.edit.expand') }} ▾</ng-container>
                                <ng-container *ngIf="expanded === i">{{ t('mux.edit.collapse') }} ▴</ng-container>
                            </button>
                        </div>

                        <div *ngIf="expanded === i" class="mux-canvas" (click)="$event.stopPropagation()">
                            <ng-container *ngTemplateOutlet="nodeTpl; context: {$implicit: w.layout, path: []}"></ng-container>
                        </div>
                        <div *ngIf="expanded === i" class="mux-sel-bar">
                            <ng-container *ngIf="selectedPath && selectedPaneSpec as p">
                                <i class="fas fa-terminal"></i>
                                <strong>{{ selectedPaneInfo.profileName }}</strong>
                                <span class="mux-badge" [class.copy]="!p.profileId">
                                    {{ p.profileId ? t('mux.ge.ref') : t('mux.ge.copy') }}
                                </span>
                            </ng-container>
                            <span class="ms-auto">{{ t('mux.ge.menuHint') }}</span>
                        </div>
                    </div>
                </div>
                <div *ngIf="!editing.windows.length" class="mux-tpl-empty">{{ t('mux.edit.noWindows') }}</div>

                <div class="d-flex align-items-center gap-2 flex-wrap mt-3">
                    <button type="button" class="btn btn-sm btn-outline-secondary" (click)="importWindow()">
                        <i class="fas fa-download me-1"></i>{{ t('mux.edit.importWindow') }}…
                    </button>
                    <button type="button" class="btn btn-sm btn-outline-secondary" (click)="addBlankWindow()">
                        <i class="fas fa-plus me-1"></i>{{ t('mux.edit.addBlankWindow') }}…
                    </button>
                </div>
            </div>
            <div class="modal-footer">
                <button type="button" class="btn btn-sm btn-secondary me-auto" (click)="previewEdit()">
                    <i class="fas fa-flask me-1"></i>{{ t('mux.edit.preview') }}
                </button>
                <button type="button" class="btn btn-sm btn-outline-danger" [disabled]="!dirty" (click)="discardEdit()">
                    {{ t('mux.edit.discard') }}
                </button>
                <button type="button" class="btn btn-sm btn-primary" [disabled]="!dirty" (click)="closeEditor(true)">
                    <i class="fas fa-check me-1"></i>{{ t('mux.edit.save') }}
                </button>
            </div>
        </ng-template>

        <!-- ==================== pane config modal ==================== -->
        <ng-template #paneTpl let-modal>
            <div class="modal-header">
                <h5 class="modal-title"><i class="fas fa-terminal me-2"></i>{{ t('mux.paneModal.title') }}</h5>
                <button type="button" class="btn-close" (click)="paneModalRef?.dismiss()"></button>
            </div>
            <div class="modal-body" *ngIf="selectedPaneSpec?.profile as pf">
                <div class="text-muted mb-3" style="font-size: 12px">{{ t('mux.paneModal.hint') }}</div>
                <div class="mux-inline-field mb-2">
                    <label>{{ t('mux.ge.paneName') }}</label>
                    <input type="text" class="form-control form-control-sm" style="width: 280px"
                           [(ngModel)]="pf.name" (ngModelChange)="dirty = true">
                </div>
                <div class="mux-inline-field mb-2" *ngIf="pf.type === 'local'">
                    <label>{{ t('mux.ge.command') }}</label>
                    <input type="text" class="form-control form-control-sm" style="width: 340px"
                           [(ngModel)]="pf.options.command" (ngModelChange)="dirty = true">
                </div>
                <div class="mux-inline-field mb-2" *ngIf="pf.type === 'local'">
                    <label>{{ t('mux.ge.cwd') }}</label>
                    <input type="text" class="form-control form-control-sm" style="width: 340px"
                           [(ngModel)]="pf.options.cwd" (ngModelChange)="dirty = true">
                </div>
                <hr>
                <div class="mux-inline-field">
                    <label>{{ t('mux.ge.promote') }}</label>
                    <input type="text" class="form-control form-control-sm" style="width: 220px"
                           [placeholder]="t('mux.ge.promoteName')" maxlength="60" [(ngModel)]="promoteName">
                    <button type="button" class="btn btn-sm btn-outline-primary"
                            [disabled]="!promoteName.trim()" (click)="promoteSelected()">
                        <i class="fas fa-upload me-1"></i>{{ t('mux.paneModal.saveAs') }}
                    </button>
                </div>
            </div>
            <div class="modal-footer">
                <button type="button" class="btn btn-sm btn-secondary" (click)="paneModalRef?.dismiss()">
                    {{ t('mux.paneModal.cancel') }}
                </button>
                <button type="button" class="btn btn-sm btn-primary" (click)="paneModalRef?.close()">
                    {{ t('mux.paneModal.save') }}
                </button>
            </div>
        </ng-template>

        <!-- recursive layout canvas -->
        <ng-template #nodeTpl let-node let-path="path">
            <ng-container *ngIf="isContainer(node)">
                <div class="mux-node" [class.mux-h]="node.orientation === 'h'" [class.mux-v]="node.orientation === 'v'">
                    <ng-container *ngFor="let child of node.children; let i = index">
                        <div *ngIf="i > 0" class="mux-divider"
                             (mousedown)="startDividerDrag($event, node, i)"></div>
                        <div class="mux-cell" [style.flex-grow]="node.ratios[i] || 1">
                            <ng-container *ngTemplateOutlet="nodeTpl; context: {$implicit: child, path: path.concat(i)}"></ng-container>
                        </div>
                    </ng-container>
                </div>
            </ng-container>
            <div *ngIf="!isContainer(node)" class="mux-gpane"
                 [class.selected]="isSelected(path)" (click)="selectPane($event, path)"
                 (contextmenu)="paneContextMenu($event, path)">
                <i class="fas fa-terminal"></i>
                <span class="mux-gname">{{ paneLabel(node.pane) }}</span>
                <span class="mux-badge" [class.copy]="!node.pane.profileId">
                    {{ node.pane.profileId ? t('mux.ge.ref') : t('mux.ge.copy') }}
                </span>
                <button type="button" class="mux-pane-edit" [title]="t('mux.settings.menuEdit')"
                        (click)="openPaneEditor($event, path)">
                    <i class="fas fa-pencil-alt"></i>
                </button>
            </div>
        </ng-template>
    `,
})
export class MuxSettingsComponent implements OnInit, OnDestroy {
    tab = 'templates'
    settings: any
    profiles: any[] = []
    private changedSub: Subscription | null = null

    // ---- template editor state ----
    editing: (MuxSessionTemplate & { windows: any[] }) | null = null
    dirty = false
    expanded: number | null = null
    selectedPath: number[] | null = null
    promoteName = ''

    @ViewChild('editorTpl', { static: false }) editorTpl?: TemplateRef<any>
    @ViewChild('paneTpl', { static: false }) paneTpl?: TemplateRef<any>
    private editorModalRef: any = null
    paneModalRef: any = null

    constructor (
        private config: ConfigService,
        private profilesService: ProfilesService,
        private i18n: I18n,
        private mux: MuxService,
        private platform: PlatformService,
        private ngb: NgbModal,
        private cdr: ChangeDetectorRef,
    ) { }

    ngOnInit (): void {
        this.settings = this.config.store[CONFIG_KEY]
        void this.profilesService.getProfiles().then(list => {
            this.profiles = list
        })
        this.changedSub = this.mux.changed$.subscribe(() => this.cdr.detectChanges())
        const w = window as any
        w.__muxSettingsComponent = this
    }

    ngOnDestroy (): void {
        this.changedSub?.unsubscribe()
    }

    get templates (): MuxSessionTemplate[] {
        return this.mux.templates
    }

    /** Profiles-page-style grouping: named groups sorted, ungrouped last. */
    get templateGroups (): { name: string, templates: MuxSessionTemplate[] }[] {
        const groups = new Map<string, MuxSessionTemplate[]>()
        for (const tpl of this.templates) {
            const key = (tpl.group ?? '').trim()
            const list = groups.get(key) ?? []
            list.push(tpl)
            groups.set(key, list)
        }
        const out: { name: string, templates: MuxSessionTemplate[] }[] = []
        for (const key of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
            if (key === '') {
                continue
            }
            out.push({ name: key, templates: groups.get(key)! })
        }
        const ungrouped = groups.get('')
        if (ungrouped?.length) {
            out.push({ name: this.t('mux.settings.tplGroupUngrouped'), templates: ungrouped })
        }
        return out
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

    /** Kebab menu of a template list entry. */
    entryMenu (event: MouseEvent, tpl: MuxSessionTemplate): void {
        const items: MenuItemOptions[] = [
            {
                label: this.t('mux.settings.menuEdit'),
                click: () => this.openEditor(tpl),
            },
            {
                label: this.t('mux.settings.menuRename'),
                click: () => void this.renameTemplate(tpl),
            },
            {
                label: this.t('mux.settings.menuSetGroup'),
                click: () => void this.setTemplateGroup(tpl),
            },
            { type: 'separator' },
            {
                label: this.t('mux.settings.menuDelete'),
                click: () => void this.mux.deleteTemplate(tpl),
            },
        ]
        this.platform.popupContextMenu(items, event)
    }

    private async renameTemplate (tpl: MuxSessionTemplate): Promise<void> {
        const name = await this.mux.promptForText('mux.windowPrompt', tpl.name)
        if (name === null) {
            return
        }
        const edited = { ...tpl, name: name.trim() || tpl.name }
        await this.mux.saveTemplateEdit(edited as any)
    }

    private async setTemplateGroup (tpl: MuxSessionTemplate): Promise<void> {
        const group = await this.mux.promptForText('mux.settings.tplGroupPrompt', tpl.group ?? '')
        if (group === null) {
            return
        }
        const edited = { ...tpl, group: group.trim() }
        await this.mux.saveTemplateEdit(edited as any)
    }

    // ==================================================================
    // Template editor (floating modal)
    // ==================================================================

    openEditor (tpl: MuxSessionTemplate): void {
        this.startEdit(tpl)
        this.editorModalRef = this.ngb.open(this.editorTpl!, {
            size: 'xl',
            backdrop: 'static',
            keyboard: false,
        })
        this.editorModalRef.result.finally(() => {
            this.editorModalRef = null
        })
    }

    /** Closes the editor modal; saves first when requested. */
    closeEditor (save: boolean): void {
        if (save) {
            this.saveEdit()
        } else if (this.dirty) {
            void this.confirmDiscard().then(ok => {
                if (ok) {
                    this.editorModalRef?.close()
                }
            })
            return
        }
        this.editorModalRef?.close()
    }

    private async confirmDiscard (): Promise<boolean> {
        const result = await this.platform.showMessageBox({
            type: 'warning',
            message: this.t('mux.edit.unsaved'),
            detail: this.t('mux.edit.discard') + '?',
            buttons: [this.t('mux.edit.keepEditing'), this.t('mux.edit.discard')],
            defaultId: 0,
            cancelId: 0,
        })
        return result.response === 1
    }

    startEdit (tpl: MuxSessionTemplate): void {
        const copy = deepClone(tpl) as any
        // Self-heal: drop windows without panes.
        copy.windows = (copy.windows ?? []).filter((w: any) => this.paneCount(w) > 0)
        this.editing = copy
        this.dirty = false
        this.expanded = null
        this.selectedPath = null
        this.promoteName = ''
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

    /** Right-click menu on a window row (duplicate / remove moved here). */
    windowContextMenu (event: MouseEvent, index: number): void {
        event.preventDefault()
        event.stopPropagation()
        const items: MenuItemOptions[] = [
            {
                label: this.t('mux.edit.duplicate') + ' - ' + this.t('mux.ge.windowUnit'),
                click: () => this.duplicateWindow(index),
            },
            { type: 'separator' },
            {
                label: this.t('mux.edit.remove') + ' - ' + this.t('mux.ge.windowUnit'),
                click: () => this.removeWindow(index),
            },
        ]
        this.platform.popupContextMenu(items, event)
    }

    async importWindow (): Promise<void> {
        if (!this.editing) {
            return
        }
        const win = await this.mux.pickSessionWindow()
        if (!win) {
            return
        }
        const spec = await this.mux.captureWindowSpec(win)
        if (spec) {
            this.editing.windows.push(spec)
            this.dirty = true
        }
    }

    async addBlankWindow (): Promise<void> {
        if (!this.editing) {
            return
        }
        const profile = await this.mux.pickProfile()
        if (!profile) {
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
    // Graphical layout canvas
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
        if (specPanes(layout).length <= 1) {
            this.removeWindow(this.expanded)
            return
        }
        deleteSpecAt(layout, this.selectedPath)
        this.selectedPath = null
        this.dirty = true
    }

    paneContextMenu (event: MouseEvent, path: number[]): void {
        event.preventDefault()
        event.stopPropagation()
        this.selectedPath = [...path]
        this.promoteName = ''
        const items: MenuItemOptions[] = [
            { label: this.t('mux.ge.splitH'), click: () => this.splitSelected('h') },
            { label: this.t('mux.ge.splitV'), click: () => this.splitSelected('v') },
            { label: this.t('mux.edit.duplicate'), click: () => this.duplicateSelected() },
            { type: 'separator' },
            { label: this.t('mux.edit.remove'), click: () => this.deleteSelected() },
            { type: 'separator' },
            { label: this.t('mux.ge.assignProfile') + '…', click: () => void this.assignProfile() },
        ]
        this.platform.popupContextMenu(items, event)
    }

    async assignProfile (): Promise<void> {
        const pane = this.selectedPaneSpec
        if (!pane) {
            return
        }
        const profile = await this.mux.pickProfile()
        if (!profile) {
            return
        }
        pane.profileId = profile.id ?? null
        pane.profile = null
        this.dirty = true
    }

    /**
     * Corner edit button: opens the pane's config in its own modal.
     * References fork on open - saving stores an independent copy with the
     * template; promoting to the global registry is an explicit action.
     */
    openPaneEditor (event: MouseEvent, path: number[]): void {
        event.stopPropagation()
        this.selectedPath = [...path]
        this.promoteName = ''
        const pane = this.selectedPaneSpec
        if (!pane) {
            return
        }
        if (pane.profileId) {
            this.forkSelected()
        }
        this.paneModalRef = this.ngb.open(this.paneTpl!, { size: 'lg' })
    }

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
        this.profiles = await this.profilesService.getProfiles()
        this.dirty = true
        this.paneModalRef?.close()
    }

    // ==================================================================
    // Divider dragging (ratio adjustment)
    // ==================================================================

    startDividerDrag (event: MouseEvent, node: MuxLayoutContainer, index: number): void {
        event.preventDefault()
        event.stopPropagation()
        const container = (event.target as HTMLElement).parentElement
        if (!container) {
            return
        }
        const horizontal = node.orientation === 'h'
        const rect = container.getBoundingClientRect()
        const size = horizontal ? rect.width : rect.height
        const prefix = node.ratios.slice(0, index - 1).reduce((a, b) => a + b, 0)
        const minR = 0.05
        const dividerEl = event.target as HTMLElement
        dividerEl.classList.add('dragging')
        const onMove = (e: MouseEvent) => {
            const pos = horizontal ? e.clientX - rect.left : e.clientY - rect.top
            let boundary = pos / Math.max(1, size)
            const lo = prefix + minR
            const hi = prefix + node.ratios[index - 1] + node.ratios[index] - minR
            boundary = Math.min(hi, Math.max(lo, boundary))
            const delta = boundary - (prefix + node.ratios[index - 1])
            node.ratios[index - 1] += delta
            node.ratios[index] -= delta
            this.cdr.detectChanges()
        }
        const onUp = () => {
            dividerEl.classList.remove('dragging')
            document.removeEventListener('mousemove', onMove)
            document.removeEventListener('mouseup', onUp)
            this.dirty = true
        }
        document.addEventListener('mousemove', onMove)
        document.addEventListener('mouseup', onUp)
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
