import { Injectable, Injector } from '@angular/core'
import { AppService, BaseTabComponent } from 'tabby-core'
import { MuxService } from './mux.service'
import { MuxWindow } from './types'

/**
 * Browser-grade tab tear-off choreography (source window side):
 *
 *  - dragging a mux window's tab outside the TAB BAR: a rounded tab card
 *    follows the cursor (the CDK drag preview is hidden while outside, so
 *    the card is the single visual) and a dwell timer starts;
 *  - after DWELL_MS outside the bar a placeholder window materializes at
 *    cursor - grabOffset (same relative point of the source window stays
 *    under the cursor) and follows the mouse via @electron/remote setBounds;
 *  - release: back inside the source window -> cancel (placeholder closes,
 *    CDK finishes the reorder); over another mux window -> merge there;
 *    elsewhere -> the pull-out is committed with the placeholder's bounds,
 *    and the placeholder stays on screen until the real window's handover
 *    completes (win-hosted), so the drop point never flickers.
 *
 * A DOM card cannot leave the source viewport, so outside the window the
 * placeholder window (whose fake tab strip carries the title) is the
 * cursor-visual. Hosts without @electron/remote degrade to card-only.
 */

const CARD_ID = 'mux-drag-card'
const STYLE_ID = 'mux-tearoff-style'
const DWELL_MS = 350
const FOLLOW_THROTTLE_MS = 16
const HANDOVER_SAFETY_MS = 65_000

interface HostRect { x: number, y: number, width: number, height: number }

@Injectable({ providedIn: 'root' })
export class MuxTearoffService {
    private readonly mux: MuxService
    private readonly app: AppService

    private started = false
    private armed = false
    private armedWin: MuxWindow | null = null
    private lastScreen: { x: number, y: number } | null = null
    private lastClient: { x: number, y: number } | null = null
    private tabBarRect: DOMRect | null = null

    private card: HTMLElement | null = null
    private cardW = 0
    private dwellTimer: any = null
    private placeholder: any = null
    private grabOffset = { x: 120, y: 24 }
    private followTimer: any = null
    /** Window whose pull-out the placeholder still covers (until win-hosted). */
    private finalizeWin: MuxWindow | null = null
    private safetyTimer: any = null

    constructor (injector: Injector) {
        this.mux = injector.get(MuxService)
        this.app = injector.get(AppService)
    }

    start (): void {
        if (this.started) {
            return
        }
        this.started = true

        const style = document.createElement('style')
        style.id = STYLE_ID
        // While outside the tab bar our card is the visual; the CDK preview
        // (a plain square clone of the tab name) would double it up.
        style.textContent = 'body.mux-drag-outside-bar .cdk-drag-preview { opacity: 0 !important; }'
        document.head.appendChild(style)

        document.addEventListener('mousemove', ev => this.onMove(ev), { capture: true, passive: true })
        this.app.tabDragActive$.subscribe(tab => this.onDragState(tab))
        this.mux.changed$.subscribe(() => this.onRegistryChanged())
    }

    // ------------------------------------------------------------------
    // Drag lifecycle
    // ------------------------------------------------------------------

    private onDragState (tab: BaseTabComponent | null): void {
        if (tab) {
            const win = this.mux.windowForTab(tab)
            if (win && this.mux.hostsWindow(win)) {
                this.armed = true
                this.armedWin = win
                this.lastScreen = null
                this.lastClient = null
                this.tabBarRect = document.querySelector('.tab-bar')?.getBoundingClientRect() ?? null
                this.clearCard()
                this.clearDwell()
                return
            }
            this.armed = false
            this.armedWin = null
            return
        }
        if (this.armed) {
            this.armed = false
            this.finish()
        }
    }

    private onMove (ev: MouseEvent): void {
        if (!this.armed) {
            return
        }
        this.lastScreen = { x: ev.screenX, y: ev.screenY }
        this.lastClient = { x: ev.clientX, y: ev.clientY }

        if (this.insideTabBar(ev.clientX, ev.clientY)) {
            // Back in the strip: plain reorder mode; a materialized
            // placeholder merges back (closes).
            this.clearCard()
            this.clearDwell()
            if (this.placeholder) {
                this.destroyPlaceholder()
            }
            return
        }

        this.ensureCard()
        this.positionCard(ev.clientX, ev.clientY)
        if (this.placeholder) {
            this.scheduleFollow()
        } else if (this.dwellTimer === null) {
            this.dwellTimer = setTimeout(() => {
                this.dwellTimer = null
                if (this.armed && this.lastClient && !this.insideTabBar(this.lastClient.x, this.lastClient.y)) {
                    this.createPlaceholder()
                }
            }, DWELL_MS)
        }
    }

    /** Release: pick cancel / merge / commit by the drop point. */
    private finish (): void {
        const pt = this.lastScreen
        const win = this.armedWin
        this.armedWin = null
        this.clearDwell()
        this.clearCard()
        if (!pt || !win || !this.mux.hostsWindow(win)) {
            this.destroyPlaceholder()
            return
        }
        const self: HostRect = { x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight }
        if (pt.x >= self.x && pt.x <= self.x + self.width && pt.y >= self.y && pt.y <= self.y + self.height) {
            // Dropped back into this window: CDK finishes the reorder/no-op.
            this.destroyPlaceholder()
            return
        }
        const host = this.mux.dropTargetHostAt(pt.x, pt.y)
        if (host !== null) {
            this.destroyPlaceholder()
            void this.mux.moveWindowTo(win, host)
            return
        }
        // Detach. Land at the cursor-implied position (the placeholder's
        // own bounds lag the 16ms follow throttle; computing from the
        // cursor is exact).
        const bounds = this.phantomBoundsAt(pt)
        if (this.placeholder) {
            // Keep the visual anchored until the real window takes over.
            this.finalizeWin = win
            this.safetyTimer = setTimeout(() => this.destroyPlaceholder(), HANDOVER_SAFETY_MS)
        }
        void this.mux.moveWindowTo(win, 'new', { bounds })
    }

    /** The handover completed - retire the placeholder. */
    private onRegistryChanged (): void {
        if (this.finalizeWin && !this.mux.hostsWindow(this.finalizeWin)) {
            this.destroyPlaceholder()
        }
    }

    // ------------------------------------------------------------------
    // Visuals: tab card
    // ------------------------------------------------------------------

    private ensureCard (): void {
        if (this.card) {
            return
        }
        const el = document.createElement('div')
        el.id = CARD_ID
        el.style.cssText =
            'position:fixed;top:0;left:0;z-index:99999;pointer-events:none;display:flex;align-items:center;gap:7px;' +
            'padding:7px 13px;border-radius:9px;font-size:12px;white-space:nowrap;max-width:240px;overflow:hidden;' +
            'background:var(--theme-bg-less-2,#3a3f44);color:var(--theme-fg,#eee);' +
            'border:1px solid var(--theme-border,#4a5057);box-shadow:0 5px 18px rgba(0,0,0,.45);' +
            'opacity:.96;user-select:none;'
        const title = this.armedWin ? this.mux.windowTitle(this.armedWin) : ''
        el.innerHTML =
            '<i class="fas fa-terminal" style="font-size:11px;opacity:.7"></i>' +
            `<span style="overflow:hidden;text-overflow:ellipsis">${escapeHtml(title)}</span>`
        document.body.appendChild(el)
        document.body.classList.add('mux-drag-outside-bar')
        this.card = el
        this.cardW = el.getBoundingClientRect().width
    }

    private positionCard (cx: number, cy: number): void {
        if (!this.card) {
            return
        }
        // Centered under the cursor, slightly below it (Chrome-style).
        this.card.style.transform = `translate3d(${Math.round(cx - this.cardW / 2)}px, ${Math.round(cy + 14)}px, 0)`
    }

    private clearCard (): void {
        if (this.card) {
            this.card.remove()
            this.card = null
        }
        document.body.classList.remove('mux-drag-outside-bar')
    }

    private clearDwell (): void {
        if (this.dwellTimer !== null) {
            clearTimeout(this.dwellTimer)
            this.dwellTimer = null
        }
    }

    // ------------------------------------------------------------------
    // Placeholder window
    // ------------------------------------------------------------------

    private createPlaceholder (): void {
        if (!this.lastScreen) {
            return
        }
        try {
            const remote: any = (require as any)('@electron/remote')
            this.rememberGrabOffset(this.lastScreen)
            const b = this.phantomBoundsAt(this.lastScreen)
            const theme = this.themeColors()
            const title = this.armedWin ? this.mux.windowTitle(this.armedWin) : ''
            this.placeholder = new remote.BrowserWindow({
                x: Math.round(b.x),
                y: Math.round(b.y),
                width: Math.round(b.width),
                height: Math.round(b.height),
                show: true,
                frame: false,
                resizable: false,
                movable: false,
                focusable: false,
                skipTaskbar: true,
                alwaysOnTop: true,
                hasShadow: true,
                backgroundColor: theme.bg,
            })
            this.placeholder.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(placeholderHtml(title, theme)))
            this.scheduleFollow()
        } catch {
            // No @electron/remote on this host: card-only tear-off; the
            // release path still lands the window at the drop point.
            this.placeholder = null
        }
    }

    private scheduleFollow (): void {
        if (this.followTimer !== null || !this.placeholder) {
            return
        }
        this.followTimer = setTimeout(() => {
            this.followTimer = null
            if (!this.placeholder || !this.lastScreen) {
                return
            }
            const b = this.phantomBoundsAt(this.lastScreen)
            try {
                this.placeholder.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) })
            } catch {
                this.destroyPlaceholder()
            }
        }, FOLLOW_THROTTLE_MS)
    }

    private destroyPlaceholder (): void {
        if (this.safetyTimer !== null) {
            clearTimeout(this.safetyTimer)
            this.safetyTimer = null
        }
        if (this.followTimer !== null) {
            clearTimeout(this.followTimer)
            this.followTimer = null
        }
        this.finalizeWin = null
        if (this.placeholder) {
            try {
                this.placeholder.destroy()
            } catch {
                // already gone
            }
            this.placeholder = null
        }
    }

    /**
     * The anchor the cursor "holds" the window by: the cursor's offset
     * within the SOURCE window at card-show time, clamped so the phantom
     * keeps a sane amount of window around the cursor.
     */
    private rememberGrabOffset (pt: { x: number, y: number }): void {
        this.grabOffset = {
            x: clamp(pt.x - window.screenX, 90, Math.max(90, window.outerWidth - 90)),
            y: clamp(pt.y - window.screenY, 14, 90),
        }
    }

    private phantomBoundsAt (pt: { x: number, y: number }): HostRect {
        return {
            x: pt.x - this.grabOffset.x,
            y: pt.y - this.grabOffset.y,
            width: window.outerWidth,
            height: window.outerHeight,
        }
    }

    private insideTabBar (cx: number, cy: number): boolean {
        if (this.tabBarRect) {
            return cx >= this.tabBarRect.left - 4 && cx <= this.tabBarRect.right + 4 &&
                cy >= this.tabBarRect.top - 4 && cy <= this.tabBarRect.bottom + 10
        }
        return cy <= 44
    }

    private themeColors (): { bg: string, bar: string, fg: string, border: string, chip: string } {
        const body = getComputedStyle(document.body)
        return {
            bg: body.getPropertyValue('--theme-bg').trim() || '#1e2126',
            bar: body.getPropertyValue('--theme-bg-more').trim() || '#23272d',
            fg: body.getPropertyValue('--theme-fg').trim() || '#e6e6e6',
            border: body.getPropertyValue('--theme-border').trim() || '#3a4048',
            chip: body.getPropertyValue('--theme-bg-less-2').trim() || '#31363d',
        }
    }
}

function clamp (v: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, v))
}

function escapeHtml (text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}

/** The blank window's chrome: a tab strip carrying the dragged tab. */
function placeholderHtml (title: string, theme: { bg: string, bar: string, fg: string, border: string, chip: string }): string {
    return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:${theme.bg};overflow:hidden}
.bar{height:36px;display:flex;align-items:flex-end;gap:6px;padding:6px 10px 0;
    background:${theme.bar};border-bottom:1px solid ${theme.border};
    color:${theme.fg};font:12px/1.4 "Segoe UI",system-ui,sans-serif}
.tab{display:flex;align-items:center;gap:8px;max-width:260px;min-width:0;
    background:${theme.chip};border:1px solid ${theme.border};border-bottom:none;
    border-radius:8px 8px 0 0;padding:8px 12px}
.t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.x{opacity:.45;font-size:13px;padding:0 2px}
.body{height:calc(100% - 36px)}
</style></head><body><div class="bar"><div class="tab">
<span>&#9000;</span><span class="t">${escapeHtml(title)}</span><span class="x">&times;</span>
</div></div><div class="body"></div></body></html>`
}
