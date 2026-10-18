import { CdkDragDrop, moveItemInArray } from '@angular/cdk/drag-drop'
import { ChangeDetectorRef, Component, OnDestroy, OnInit, TemplateRef, ViewChild } from '@angular/core'
import { ConfigService, MenuItemOptions, PlatformService, ProfilesService } from 'tabby-core'
import { EditProfileModalComponent } from 'tabby-settings'
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
 * Settings page for tabby-mux, mirroring the native settings conventions:
 * ngbNav tabs, the templates list styled after the profiles page
 * (collapse-container with collapsible groups, hover-reveal actions, a
 * New dropdown), and floating modal editors.
 *
 * Structural note: the editor/pane modals use static backdrops, so they
 * MUST be dismissed when this component goes away (section/tab switch) -
 * otherwise the leftover overlay blocks every click on the settings page.
 */
@Component({
    selector: 'mux-settings',
    styles: [`
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
        /* collapse list - copied from profilesSettingsTab.component.scss
           (native classes are scoped to their components) */
        .mux-collapse-container {
            background-color: var(--theme-bg-less);
            border-radius: 0.375rem;
        }
        .mux-collapse-item {
            height: 2.25rem;
            background-color: var(--theme-bg-less);
            border-radius: 0.3rem;
            cursor: pointer;
        }
        .mux-collapse-item:hover { background-color: var(--theme-bg-less-2); }
        .mux-hover-reveal { visibility: hidden; }
        .mux-collapse-item:hover .mux-hover-reveal, .mux-hover-reveal.show { visibility: visible; }
        .no-wrap { white-space: nowrap; }
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
        .mux-tpl-row .mux-tpl-meta { font-size: 12px; color: var(--theme-fg-more, #999); }
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

        <ul ngbNav #nav="ngbNav" class="nav-tabs" [destroyOnHide]="false">
            <li ngbNavItem>
                <a ngbNavLink>{{ t('mux.settings.tabTemplates') }}</a>
                <ng-template ngbNavContent>
                    <div class="d-flex mb-3">
                        <div class="input-group">
                            <span class="input-group-text"><i class="fas fa-fw fa-search"></i></span>
                            <input type="search" class="form-control"
                                   [placeholder]="t('mux.settings.filter')" [(ngModel)]="filter">
                        </div>
                        <div ngbDropdown class="d-inline-block flex-shrink-0 ms-3">
                            <button type="button" class="btn btn-primary" ngbDropdownToggle>
                                <i class="fas fa-fw fa-plus"></i>{{ t('mux.new') }}
                            </button>
                            <div ngbDropdownMenu>
                                <button ngbDropdownItem (click)="newTemplate()">
                                    <i class="fas fa-fw fa-plus"></i>{{ t('mux.newTemplate') }}
                                </button>
                                <button ngbDropdownItem (click)="newTemplateGroup()">
                                    <i class="fas fa-fw fa-plus"></i>{{ t('mux.newGroup') }}
                                </button>
                            </div>
                        </div>
                    </div>

                    <div class="d-flex flex-column my-3 p-2 mux-collapse-container">
                        <ng-container *ngFor="let grp of templateGroups; trackBy: trackGroupByName">
                            <div class="mux-collapse-item d-flex align-items-center p-1"
                                 (click)="toggleGroupCollapse(grp.name)">
                                <i class="fa fa-fw far" [class.fa-folder]="grp.collapsed"
                                   [class.fa-folder-open]="!grp.collapsed"></i>
                                <span class="ms-3 me-auto no-wrap">{{ grp.display }}</span>
                                <button type="button" class="btn btn-sm btn-link mux-hover-reveal ms-2"
                                        *ngIf="grp.name"
                                        (click)="$event.stopPropagation(); renameGroup(grp.name)">
                                    <i class="fas fa-pencil-alt"></i>
                                </button>
                                <button type="button" class="btn btn-sm btn-link mux-hover-reveal ms-2 text-danger"
                                        *ngIf="grp.name"
                                        (click)="$event.stopPropagation(); deleteGroup(grp.name)">
                                    <i class="fas fa-trash-alt"></i>
                                </button>
                            </div>
                            <ng-container *ngIf="!grp.collapsed">
                                <div *ngFor="let tpl of filteredTemplates(grp.templates); trackBy: trackTemplateById"
                                     class="mux-collapse-item d-flex align-items-center p-1 ps-4"
                                     (click)="openEditor(tpl)">
                                    <i class="fas fa-fw fa-layer-group ms-1"></i>
                                    <span class="ms-3 no-wrap">{{ tpl.name }}</span>
                                    <span class="text-muted no-wrap ms-2">
                                        {{ t('mux.settings.tplWindows', { n: tpl.windows.length }) }}
                                    </span>
                                    <div class="me-auto"></div>
                                    <button type="button" class="btn btn-link mux-hover-reveal ms-1"
                                            (click)="$event.stopPropagation(); applyTemplate(tpl)">
                                        <i class="fas fa-play"></i>
                                    </button>
                                    <div ngbDropdown placement="bottom-right top-right auto" class="ms-1 mux-hover-reveal">
                                        <button type="button" class="btn btn-link ms-1" ngbDropdownToggle
                                                (click)="$event.stopPropagation()">
                                            <i class="fas fa-fw fa-ellipsis-vertical"></i>
                                        </button>
                                        <div ngbDropdownMenu>
                                            <button ngbDropdownItem
                                                    (click)="$event.stopPropagation(); renameTemplate(tpl)">
                                                <i class="fas fa-fw fa-pencil-alt"></i>{{ t('mux.settings.menuRename') }}
                                            </button>
                                            <button ngbDropdownItem
                                                    (click)="$event.stopPropagation(); setTemplateGroup(tpl)">
                                                <i class="fas fa-fw fa-folder"></i>{{ t('mux.settings.menuSetGroup') }}
                                            </button>
                                            <button ngbDropdownItem
                                                    (click)="$event.stopPropagation(); deleteTemplate(tpl)">
                                                <i class="fas fa-fw fa-trash-alt"></i>{{ t('mux.settings.menuDelete') }}
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </ng-container>
                        </ng-container>
                        <div *ngIf="!templateGroups.length" class="mux-tpl-empty">
                            {{ t('mux.settings.tplEmpty') }}
                        </div>
                    </div>
                </ng-template>
            </li>
            <li ngbNavItem>
                <a ngbNavLink>{{ t('mux.settings.tabGeneral') }}</a>
                <ng-template ngbNavContent>
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
                        <div class="mux-line-header"><div class="title">{{ t('mux.settings.showSessionIndex') }}</div></div>
                        <div class="mux-line-control">
                            <div class="form-check form-switch">
                                <input type="checkbox" class="form-check-input" id="mux-show-index"
                                       [(ngModel)]="settings.showSessionIndex" (ngModelChange)="save()">
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
                        <div class="mux-line-header"><div class="title">{{ t('mux.settings.foreignTabsToTail') }}</div></div>
                        <div class="mux-line-control">
                            <div class="form-check form-switch">
                                <input type="checkbox" class="form-check-input" id="mux-foreign-tail"
                                       [(ngModel)]="settings.foreignTabsToTail" (ngModelChange)="save()">
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
                </ng-template>
            </li>
        </ul>
        <div [ngbNavOutlet]="nav" class="mt-2"></div>

        <!-- ==================== template editor modal ==================== -->
        <ng-template #editorTpl>
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
    settings: any
    profiles: any[] = []
    filter = ''
    private changedSub: Subscription | null = null

    // ---- template editor state ----
    editing: (MuxSessionTemplate & { windows: any[] }) | null = null
    dirty = false
    expanded: number | null = null
    selectedPath: number[] | null = null
    promoteName = ''

    @ViewChild('editorTpl', { static: false }) editorTpl?: TemplateRef<any>
    private editorModalRef: any = null

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
        // Static backdrops: an open modal must never outlive this component,
        // or its overlay blocks every click on the settings page.
        this.editorModalRef?.dismiss()
    }

    get templates (): MuxSessionTemplate[] {
        return this.mux.templates
    }

    /**
     * Profiles-page-style grouping: explicit groups (may be empty) plus
     * implicit groups from template.group, sorted; ungrouped last.
     */
    get templateGroups (): { name: string, display: string, templates: MuxSessionTemplate[], collapsed: boolean }[] {
        const groups = new Map<string, MuxSessionTemplate[]>()
        for (const name of this.settings.templateGroups ?? []) {
            groups.set(name, [])
        }
        for (const tpl of this.templates) {
            const key = (tpl.group ?? '').trim()
            const list = groups.get(key) ?? []
            list.push(tpl)
            groups.set(key, list)
        }
        const collapsed = new Set(this.settings.collapsedGroups ?? [])
        const out: { name: string, display: string, templates: MuxSessionTemplate[], collapsed: boolean }[] = []
        for (const name of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
            if (name === '') {
                continue
            }
            out.push({ name, display: name, templates: groups.get(name)!, collapsed: collapsed.has(name) })
        }
        const ungrouped = groups.get('')
        if (ungrouped?.length) {
            out.push({
                name: '',
                display: this.t('mux.settings.tplGroupUngrouped'),
                templates: ungrouped,
                collapsed: collapsed.has(''),
            })
        }
        return out
    }

    filteredTemplates (list: MuxSessionTemplate[]): MuxSessionTemplate[] {
        const needle = this.filter.trim().toLowerCase()
        if (!needle) {
            return list
        }
        return list.filter(tpl => tpl.name.toLowerCase().includes(needle))
    }

    /**
     * The app runs change detection at a high frequency; without stable
     * trackBy identities the getter's fresh object arrays made the ngFor
     * tear down and rebuild its DOM ~40x/s, which replaced nodes between
     * mousedown and mouseup and prevented Chromium from synthesizing
     * click events at all (dead clicks on rows and group headers).
     */
    trackGroupByName (_index: number, grp: { name: string }): string {
        return grp.name
    }

    trackTemplateById (_index: number, tpl: MuxSessionTemplate): string {
        return tpl.id
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

    // ---- group management ----

    private persistGroups (groups: string[]): void {
        this.config.store[CONFIG_KEY].templateGroups = groups
        void this.config.save()
    }

    toggleGroupCollapse (name: string): void {
        const current: string[] = [...(this.settings.collapsedGroups ?? [])]
        const index = current.indexOf(name)
        if (index === -1) {
            current.push(name)
        } else {
            current.splice(index, 1)
        }
        this.config.store[CONFIG_KEY].collapsedGroups = current
        void this.config.save()
    }

    async newTemplateGroup (): Promise<void> {
        const name = await this.mux.promptForText('mux.settings.tplGroupPrompt', '')
        if (name === null || !name.trim()) {
            return
        }
        const groups: string[] = this.settings.templateGroups ?? []
        if (!groups.includes(name.trim())) {
            this.persistGroups([...groups, name.trim()])
        }
    }

    async renameGroup (name: string): Promise<void> {
        const next = await this.mux.promptForText('mux.settings.tplGroupPrompt', name)
        if (next === null || !next.trim() || next.trim() === name) {
            return
        }
        const groups: string[] = this.settings.templateGroups ?? []
        this.persistGroups(groups.map(g => g === name ? next.trim() : g))
        for (const tpl of this.templates.filter(t => (t.group ?? '') === name)) {
            await this.mux.saveTemplateEdit({ ...tpl, group: next.trim() } as any)
        }
    }

    async deleteGroup (name: string): Promise<void> {
        const groups: string[] = this.settings.templateGroups ?? []
        this.persistGroups(groups.filter(g => g !== name))
        for (const tpl of this.templates.filter(t => (t.group ?? '') === name)) {
            await this.mux.saveTemplateEdit({ ...tpl, group: '' } as any)
        }
    }

    // ---- template list actions ----

    async newTemplate (): Promise<void> {
        const groups: string[] = this.settings.templateGroups ?? []
        const tpl: MuxSessionTemplate = {
            id: `tpl-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
            name: this.uniqueTemplateName(this.t('mux.newTemplate')),
            group: groups[0] ?? '',
            createdAt: Date.now(),
            windows: [],
        }
        this.config.store[CONFIG_KEY].templates = [...this.templates, tpl]
        await this.config.save()
        this.openEditor(tpl)
    }

    private uniqueTemplateName (base: string): string {
        const names = new Set(this.templates.map(t => t.name))
        if (!names.has(base)) {
            return base
        }
        let n = 2
        while (names.has(`${base} ${n}`)) {
            n++
        }
        return `${base} ${n}`
    }

    async renameTemplate (tpl: MuxSessionTemplate): Promise<void> {
        const name = await this.mux.promptForText('mux.windowPrompt', tpl.name)
        if (name === null) {
            return
        }
        await this.mux.saveTemplateEdit({ ...tpl, name: name.trim() || tpl.name } as any)
    }

    async setTemplateGroup (tpl: MuxSessionTemplate): Promise<void> {
        const group = await this.mux.promptForText('mux.settings.tplGroupPrompt', tpl.group ?? '')
        if (group === null) {
            return
        }
        await this.mux.saveTemplateEdit({ ...tpl, group: group.trim() } as any)
    }

    // ==================================================================
    // Template editor (floating modal)
    // ==================================================================

    openEditor (tpl: MuxSessionTemplate): void {
        if (this.editorModalRef) {
            this.editorModalRef.dismiss()
        }
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
        const pane = this.selectedPaneSpec
        const items: MenuItemOptions[] = [
            { label: this.t('mux.ge.splitH'), click: () => this.splitSelected('h') },
            { label: this.t('mux.ge.splitV'), click: () => this.splitSelected('v') },
            { label: this.t('mux.edit.duplicate'), click: () => this.duplicateSelected() },
            { type: 'separator' },
            { label: this.t('mux.edit.remove'), click: () => this.deleteSelected() },
            { type: 'separator' },
            { label: this.t('mux.ge.assignProfile') + '…', click: () => void this.assignProfile() },
        ]
        if (pane?.profile) {
            items.push({
                label: this.t('mux.paneModal.saveAs') + '…',
                click: () => void this.promoteSelectedWithPrompt(),
            })
        }
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
     * Corner edit button: opens the NATIVE connection/profile editor for the
     * pane's config (same modal the profiles page uses). Cancelling or
     * saving without changes keeps the pane exactly as it was (pure
     * reference stays a reference); only a modified save stores an
     * independent copy with the template.
     */
    async openPaneEditor (event: MouseEvent, path: number[]): Promise<void> {
        event.stopPropagation()
        this.selectedPath = [...path]
        this.promoteName = ''
        const pane = this.selectedPaneSpec
        if (!pane) {
            return
        }
        const current = pane.profileId
            ? this.profiles.find(p => p.id === pane.profileId) ?? null
            : pane.profile
        if (!current) {
            return
        }
        const provider = this.profilesService.providerForProfile(current)
        if (!provider) {
            return
        }
        const modal = this.ngb.open(EditProfileModalComponent, { size: 'lg' })
        modal.componentInstance.partialProfile = deepClone(current)
        modal.componentInstance.profileProvider = provider
        const result = await modal.result.catch(() => null)
        if (!result) {
            return // dismissed / cancelled
        }
        result.type = provider.id
        if (JSON.stringify(result) === JSON.stringify(deepClone(current))) {
            return // saved without changes - keep the reference semantics
        }
        delete result.icon
        pane.profile = result
        pane.profileId = null
        this.dirty = true
    }

    /** Explicit "save back to registry" action (pane context menu). */
    async promoteSelectedWithPrompt (): Promise<void> {
        const pane = this.selectedPaneSpec
        if (!pane || !pane.profile) {
            return
        }
        const name = await this.mux.promptForText('mux.ge.promoteName', pane.profile.name ?? '')
        if (name === null || !name.trim()) {
            return
        }
        await this.mux.promotePaneProfile(pane, name)
        this.profiles = await this.profilesService.getProfiles()
        this.dirty = true
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
