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
        'mux.sessionPrompt': 'Session name',
        'mux.windowPrompt': 'Window name',
        'mux.toolbarButton': 'New mux session',
        'mux.statusbar.session': 'Session {name} - click to switch',
        'mux.statusbar.pane': 'pane {cur}/{n}',
        'mux.statusbar.zoomed': 'zoomed',
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
        'mux.sessionPrompt': '会话名称',
        'mux.windowPrompt': '窗口名称',
        'mux.toolbarButton': '新建 Mux 会话',
        'mux.statusbar.session': '会话 {name} - 点击切换',
        'mux.statusbar.pane': '窗格 {cur}/{n}',
        'mux.statusbar.zoomed': '已缩放',
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
