import { Injectable } from '@angular/core'
import { LocaleService } from 'tabby-core'

// @ngx-translate/core is NOT usable from user plugins (only resolvable on the
// builtin app.asar module chain) - a require failure would silently kill this
// plugin and every user plugin loaded after it. LocaleService is the safe path.
const TRANSLATIONS: Record<'en' | 'zh', Record<string, string>> = {
    en: {
        'mux.newSession': 'Mux: new session',
        'mux.renameSession': 'Mux: rename session',
        'mux.switchSessionNext': 'Mux: switch to next session',
        'mux.switchSessionPrev': 'Mux: switch to previous session',
        'mux.killSession': 'Mux: kill session',
        'mux.newWindow': 'Mux: new window',
        'mux.renameWindow': 'Mux: rename window',
        'mux.killWindow': 'Mux: kill window',
        'mux.nextWindow': 'Mux: next window',
        'mux.previousWindow': 'Mux: previous window',
        'mux.selectWindow': 'Mux: select window {n}',
        'mux.splitPaneRight': 'Mux: split pane left/right',
        'mux.splitPaneBottom': 'Mux: split pane top/bottom',
        'mux.killPane': 'Mux: kill pane',
        'mux.nextPane': 'Mux: next pane',
        'mux.previousPane': 'Mux: previous pane',
        'mux.paneLeft': 'Mux: select pane on the left',
        'mux.paneRight': 'Mux: select pane on the right',
        'mux.paneUp': 'Mux: select pane above',
        'mux.paneDown': 'Mux: select pane below',
        'mux.paneZoom': 'Mux: toggle pane zoom',
        'mux.paneEqualize': 'Mux: equalize pane sizes',
        'mux.paneGrowVertical': 'Mux: grow pane vertically',
        'mux.paneShrinkVertical': 'Mux: shrink pane vertically',
        'mux.paneGrowHorizontal': 'Mux: grow pane horizontally',
        'mux.paneShrinkHorizontal': 'Mux: shrink pane horizontally',
        'mux.toggleStatusbar': 'Mux: toggle status bar',
        'mux.toggleIsolation': 'Mux: toggle session isolation (tmux attach mode)',
        'mux.toggleSidebar': 'Mux: toggle session sidebar',
        'mux.saveSessionTemplate': 'Mux: save current session as template',
        'mux.applySessionTemplate': 'Mux: new session from template "{name}"',
        'mux.sessionPrompt': 'Session name',
        'mux.windowPrompt': 'Window name',
        'mux.templatePrompt': 'Template name',
        'mux.toolbarButton': 'New mux session',
        'mux.statusbar.session': 'Session {name} - click to switch',
        'mux.statusbar.pane': 'pane {cur}/{n}',
        'mux.statusbar.zoomed': 'zoomed',
        'mux.rail.header': 'Sessions',
        'mux.rail.newSession': 'New session',
        // ---- settings page ----
        'mux.settings.title': 'Tabby Mux',
        'mux.settings.tabStatusbar': 'Status bar',
        'mux.settings.tabSidebar': 'Sidebar',
        'mux.settings.tabSessions': 'Sessions',
        'mux.settings.tabTemplates': 'Templates',
        'mux.settings.sbEnabled': 'Show status bar',
        'mux.settings.sbHeight': 'Height (px)',
        'mux.settings.sbPaneInfo': 'Show pane info (pane i/n)',
        'mux.settings.sbCpu': 'Show CPU usage',
        'mux.settings.sbMem': 'Show memory usage',
        'mux.settings.sbInterval': 'Resource refresh interval (ms)',
        'mux.settings.railEnabled': 'Show session sidebar (leftmost)',
        'mux.settings.railWidth': 'Width (px)',
        'mux.settings.isolated': 'Session isolation (tmux attach mode)',
        'mux.settings.autoAdopt': 'Auto-adopt new terminal tabs into the active session',
        'mux.settings.defaultName': 'Default session name (empty = 0, 1, 2...)',
        'mux.settings.profile': 'Profile for new windows',
        'mux.settings.profileAuto': 'Automatic (inherit focused pane)',
        'mux.settings.tplEmpty': 'No templates yet. Save the current session as a template to reuse its workspace layout.',
        'mux.settings.tplSave': 'Save current session as template',
        'mux.settings.tplWindows': '{n} window(s)',
        'mux.settings.tplApply': 'New session from this template',
        'mux.settings.tplDelete': 'Delete template',
        // ---- template browsing / context menus ----
        'mux.tmpl.section': 'Templates',
        'mux.tmpl.search': 'Search templates...',
        'mux.tmpl.browse': 'Browse templates and create a session',
        'mux.tmpl.apply': 'New session from this template',
        'mux.tmpl.delete': 'Delete template',
        'mux.tmpl.none': '(no match)',
        'mux.session.saveTemplate': 'Save as template',
        'mux.session.rename': 'Rename session',
        'mux.session.kill': 'Kill session',
        // ---- template editor ----
        'mux.edit.short': 'Edit',
        'mux.edit.back': 'Back to templates',
        'mux.edit.keepEditing': 'Keep editing',
        'mux.edit.unsaved': 'Unsaved changes',
        'mux.edit.save': 'Save',
        'mux.edit.discard': 'Discard',
        'mux.edit.preview': 'Preview (apply working copy)',
        'mux.edit.name': 'Template name',
        'mux.edit.windows': 'Windows (drag or arrows to reorder)',
        'mux.edit.window': 'Window {n}',
        'mux.edit.panes': '{n} pane(s)',
        'mux.edit.expand': 'Edit panes',
        'mux.edit.collapse': 'Collapse',
        'mux.edit.up': 'Move up',
        'mux.edit.down': 'Move down',
        'mux.edit.duplicate': 'Duplicate',
        'mux.edit.remove': 'Remove',
        'mux.edit.addBlankWindow': 'Add blank window',
        'mux.edit.importWindow': 'Import window from session',
        'mux.edit.noWindows': 'No windows - add one below or import from the current session.',
        'mux.edit.sessionPicker': 'Current session',
        'mux.edit.empty': '(empty)',
        // ---- graphical layout editor ----
        'mux.ge.selectHint': 'Click a pane to select and edit it',
        'mux.ge.ref': 'Reference',
        'mux.ge.copy': 'Copy',
        'mux.ge.splitH': 'Split H',
        'mux.ge.splitV': 'Split V',
        'mux.ge.fork': 'Edit config',
        'mux.ge.paneName': 'Name',
        'mux.ge.command': 'Command',
        'mux.ge.cwd': 'Working directory',
        'mux.ge.promote': 'Save as profile',
        'mux.ge.promoteName': 'New profile name',
    },
    zh: {
        'mux.newSession': 'Mux：新建会话',
        'mux.renameSession': 'Mux：重命名会话',
        'mux.switchSessionNext': 'Mux：切换到下一个会话',
        'mux.switchSessionPrev': 'Mux：切换到上一个会话',
        'mux.killSession': 'Mux：关闭会话',
        'mux.newWindow': 'Mux：新建窗口',
        'mux.renameWindow': 'Mux：重命名窗口',
        'mux.killWindow': 'Mux：关闭窗口',
        'mux.nextWindow': 'Mux：下一个窗口',
        'mux.previousWindow': 'Mux：上一个窗口',
        'mux.selectWindow': 'Mux：选择窗口 {n}',
        'mux.splitPaneRight': 'Mux：左右分割窗格',
        'mux.splitPaneBottom': 'Mux：上下分割窗格',
        'mux.killPane': 'Mux：关闭窗格',
        'mux.nextPane': 'Mux：下一个窗格',
        'mux.previousPane': 'Mux：上一个窗格',
        'mux.paneLeft': 'Mux：选择左侧窗格',
        'mux.paneRight': 'Mux：选择右侧窗格',
        'mux.paneUp': 'Mux：选择上方窗格',
        'mux.paneDown': 'Mux：选择下方窗格',
        'mux.paneZoom': 'Mux：窗格缩放切换',
        'mux.paneEqualize': 'Mux：均分窗格大小',
        'mux.paneGrowVertical': 'Mux：窗格纵向放大',
        'mux.paneShrinkVertical': 'Mux：窗格纵向缩小',
        'mux.paneGrowHorizontal': 'Mux：窗格横向放大',
        'mux.paneShrinkHorizontal': 'Mux：窗格横向缩小',
        'mux.toggleStatusbar': 'Mux：切换状态栏显示',
        'mux.toggleIsolation': 'Mux：切换会话隔离（tmux 附着模式）',
        'mux.toggleSidebar': 'Mux：切换会话侧栏',
        'mux.saveSessionTemplate': 'Mux：保存当前会话为模板',
        'mux.applySessionTemplate': 'Mux：从模板"{name}"新建会话',
        'mux.sessionPrompt': '会话名称',
        'mux.windowPrompt': '窗口名称',
        'mux.templatePrompt': '模板名称',
        'mux.toolbarButton': '新建 Mux 会话',
        'mux.statusbar.session': '会话 {name} - 点击切换',
        'mux.statusbar.pane': '窗格 {cur}/{n}',
        'mux.statusbar.zoomed': '已缩放',
        'mux.rail.header': '会话',
        'mux.rail.newSession': '新建会话',
        // ---- 设置页 ----
        'mux.settings.title': 'Tabby Mux',
        'mux.settings.tabStatusbar': '状态栏',
        'mux.settings.tabSidebar': '侧栏',
        'mux.settings.tabSessions': '会话',
        'mux.settings.tabTemplates': '模板',
        'mux.settings.sbEnabled': '显示状态栏',
        'mux.settings.sbHeight': '高度（px）',
        'mux.settings.sbPaneInfo': '显示窗格信息（pane i/n）',
        'mux.settings.sbCpu': '显示 CPU 使用率',
        'mux.settings.sbMem': '显示内存使用率',
        'mux.settings.sbInterval': '资源刷新间隔（ms）',
        'mux.settings.railEnabled': '显示会话侧栏（最左侧）',
        'mux.settings.railWidth': '宽度（px）',
        'mux.settings.isolated': '会话隔离（tmux 附着模式）',
        'mux.settings.autoAdopt': '自动领养新终端 tab 到当前会话',
        'mux.settings.defaultName': '默认会话名（留空 = 0, 1, 2…）',
        'mux.settings.profile': '新窗口使用的 Profile',
        'mux.settings.profileAuto': '自动（继承焦点窗格）',
        'mux.settings.tplEmpty': '还没有模板。把当前会话保存为模板即可复用它的工作区布局。',
        'mux.settings.tplSave': '保存当前会话为模板',
        'mux.settings.tplWindows': '{n} 个窗口',
        'mux.settings.tplApply': '从此模板新建会话',
        'mux.settings.tplDelete': '删除模板',
        // ---- 模板浏览 / 右键菜单 ----
        'mux.tmpl.section': '模板',
        'mux.tmpl.search': '搜索模板…',
        'mux.tmpl.browse': '浏览模板并新建会话',
        'mux.tmpl.apply': '从此模板新建会话',
        'mux.tmpl.delete': '删除模板',
        'mux.tmpl.none': '（无匹配）',
        'mux.session.saveTemplate': '保存为模板',
        'mux.session.rename': '重命名会话',
        'mux.session.kill': '关闭会话',
        // ---- 模板编辑器 ----
        'mux.edit.short': '编辑',
        'mux.edit.back': '返回模板列表',
        'mux.edit.keepEditing': '继续编辑',
        'mux.edit.unsaved': '有未保存更改',
        'mux.edit.save': '保存',
        'mux.edit.discard': '放弃更改',
        'mux.edit.preview': '预览应用（用当前编辑内容）',
        'mux.edit.name': '模板名称',
        'mux.edit.windows': '窗口列表（拖拽或箭头排序）',
        'mux.edit.window': '窗口 {n}',
        'mux.edit.panes': '{n} 个窗格',
        'mux.edit.expand': '编辑窗格',
        'mux.edit.collapse': '收起',
        'mux.edit.up': '上移',
        'mux.edit.down': '下移',
        'mux.edit.duplicate': '复制',
        'mux.edit.remove': '删除',
        'mux.edit.addBlankWindow': '添加空白窗口',
        'mux.edit.importWindow': '从当前会话导入窗口',
        'mux.edit.noWindows': '暂无窗口——从下方添加，或从当前会话导入。',
        'mux.edit.sessionPicker': '当前会话',
        'mux.edit.empty': '（空）',
        // ---- 图形化布局编辑器 ----
        'mux.ge.selectHint': '点击窗格进行选择与编辑',
        'mux.ge.ref': '引用',
        'mux.ge.copy': '独立副本',
        'mux.ge.splitH': '水平拆分',
        'mux.ge.splitV': '垂直拆分',
        'mux.ge.fork': '修改配置',
        'mux.ge.paneName': '名称',
        'mux.ge.command': '命令',
        'mux.ge.cwd': '工作目录',
        'mux.ge.promote': '存为新 Profile',
        'mux.ge.promoteName': '新 Profile 名称',
    },
}

function tableFor (locale: string): Record<string, string> {
    if (/^zh(-|$)/i.test(locale)) {
        return TRANSLATIONS.zh
    }
    return TRANSLATIONS.en
}

/** Standalone translation for non-DI contexts. */
export function translateText (locale: string, key: string): string {
    return tableFor(locale)[key] ?? key
}

@Injectable({ providedIn: 'root' })
export class I18n {
    constructor (private localeService: LocaleService) { }

    get locale (): string {
        return this.localeService.getLocale()
    }

    get localeChanged$ () {
        return this.localeService.localeChanged$
    }

    t (key: string, params?: Record<string, any>): string {
        let text = tableFor(this.locale)[key] ?? key
        if (params) {
            for (const [k, v] of Object.entries(params)) {
                text = text.split(`{${k}}`).join(String(v))
            }
        }
        return text
    }
}
