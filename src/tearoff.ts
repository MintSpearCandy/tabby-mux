import { Injectable, Injector } from '@angular/core'
import { AppService, BaseTabComponent } from 'tabby-core'
import { MuxService } from './mux.service'
import { MuxWindow } from './types'

/**
 * Browser-grade tab tear-off choreography (source window side):
 *
 *  - dragging a mux window's tab outside the TAB BAR: a rounded tab card
 *    follows the cursor (the CDK drag preview is hidden while outside, so
 *    the card is the single in-window visual) and a dwell timer starts;
 *  - after DWELL_MS outside the bar the tear-off target window is created
 *    for real - one empty Tabby window (@electron/remote diff identifies
 *    its BrowserWindow handle; setBounds lands it at cursor - grabOffset
 *    before it even shows, temporarily always-on-top) and it follows the
 *    mouse until release. No fake preview, no second window later;
 *  - release INSIDE the tab bar -> cancel (target closes, CDK finishes the
 *    reorder); over another mux window -> merge there (target closes);
 *    anywhere else - including this window's content area - the pull-out is
 *    committed straight into the target window (stash claim = its host id,
 *    bounds = cursor-implied), so the tab lands exactly where it was
 *    dragged, instantly for an already-booted target.
 *
 * Hosts without @electron/remote degrade to card-only with a post-release
 * window creation.
 */

const CARD_ID = 'mux-drag-card'
const STYLE_ID = 'mux-tearoff-style'
const DWELL_MS = 300
const FOLLOW_THROTTLE_MS = 16
/** Freshness window for the focus-handback hint a target window reads at boot. */
const BOOST_TTL_MS = 30_000
const BOOST_KEY = 'mux:tearoff-boost'

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
    /** Back-in-the-bar hysteresis: the target window is released only after the anchor stays in the strip this long. */
    private returnTimer: any = null
    private static readonly RETURN_MS = 300
    /** Last mousedown - the true grab point for the anchor. */
    private grabPoint: { x: number, y: number, ts: number } | null = null
    private anchorReady = false
    /** The tear-off target: a real, empty host window following the cursor. */
    private target: any = null
    private targetHostId: number | null = null
    private grabOffset = { x: 120, y: 24 }
    private followTimer: any = null

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
        document.addEventListener('mousedown', ev => {
            this.grabPoint = { x: ev.screenX, y: ev.screenY, ts: Date.now() }
        }, { capture: true, passive: true })
        this.app.tabDragActive$.subscribe(tab => this.onDragState(tab))
        this.handBackFocusIfTarget()
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
                // The anchor is WHERE THE TAB WAS GRABBED: cdkDragStarted
                // fires a few hundred ms after mousedown, so the most recent
                // mousedown is the grab point. Without one (synthetic tests)
                // the first cursor sample after arming stands in.
                this.anchorReady = false
                if (this.grabPoint && Date.now() - this.grabPoint.ts < 1500) {
                    this.rememberGrabOffset(this.grabPoint)
                    this.anchorReady = true
                }
                this.clearCard()
                this.clearDwell()
                this.clearReturnTimer()
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
        if (!this.anchorReady) {
            this.rememberGrabOffset(this.lastScreen)
            this.anchorReady = true
        }

        if (this.insideTabBar(ev.clientX, ev.clientY)) {
            // Back in the strip: tab form returns immediately (card away,
            // CDK reorder preview visible again). The target window is
            // released only after the anchor STAYS in the strip for a
            // moment - leaving again before that keeps it alive and
            // following, with no re-creation cost.
            this.clearCard()
            this.clearDwell()
            if (this.target && this.returnTimer === null) {
                this.returnTimer = setTimeout(() => {
                    this.returnTimer = null
                    if (this.armed && this.lastClient && this.insideTabBar(this.lastClient.x, this.lastClient.y)) {
                        this.destroyTarget()
                    }
                }, MuxTearoffService.RETURN_MS)
            }
            return
        }

        if (this.returnTimer !== null) {
            clearTimeout(this.returnTimer)
            this.returnTimer = null
        }
        this.ensureCard()
        this.positionCard(ev.clientX, ev.clientY)
        if (this.target) {
            this.scheduleFollow()
        } else if (this.dwellTimer === null) {
            this.dwellTimer = setTimeout(() => {
                this.dwellTimer = null
                if (this.armed && this.lastClient && !this.insideTabBar(this.lastClient.x, this.lastClient.y)) {
                    this.createTarget()
                }
            }, DWELL_MS)
        }
    }

    /**
     * Release. The decision boundary is the TAB BAR (not the window):
     * dropping anywhere outside it detaches into the target window.
     */
    private finish (): void {
        const pt = this.lastScreen
        const client = this.lastClient
        const win = this.armedWin
        this.armedWin = null
        this.clearDwell()
        this.clearCard()
        if (!pt || !win || !this.mux.hostsWindow(win)) {
            this.destroyTarget()
            return
        }
        const bounds = this.phantomBoundsAt(pt)
        if (client && this.insideTabBar(client.x, client.y)) {
            // Dropped back into the strip: CDK finishes the reorder.
            this.destroyTarget()
            return
        }
        const host = this.mux.dropTargetHostAt(pt.x, pt.y)
        if (host !== null && host !== this.targetHostId) {
            // Over a genuinely different mux window: merge there.
            this.destroyTarget()
            void this.mux.moveWindowTo(win, host)
            return
        }
        if (this.target && this.targetHostId !== null) {
            // Commit into the live target window: it is already at the drop
            // point; only the tab moves. It becomes a normal window again.
            try {
                this.target.setAlwaysOnTop(false)
            } catch {
                // cosmetic
            }
            void this.mux.moveWindowTo(win, this.targetHostId, { bounds })
            this.forgetTarget()
            return
        }
        // Fast release before the target materialized: create the window
        // post-release and land it at the drop point.
        void this.mux.moveWindowTo(win, 'new', { bounds })
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

    private clearReturnTimer (): void {
        if (this.returnTimer !== null) {
            clearTimeout(this.returnTimer)
            this.returnTimer = null
        }
    }

    // ------------------------------------------------------------------
    // Tear-off target window (the real one - it receives the tab)
    // ------------------------------------------------------------------

    private createTarget (): void {
        if (!this.lastScreen) {
            return
        }
        try {
            const remote: any = (require as any)('@electron/remote')
            const before = new Set(remote.BrowserWindow.getAllWindows().map((w: any) => w.id))
            const b = this.phantomBoundsAt(this.lastScreen)
            this.mux.openNewHostWindow()
            // The handle exists the moment the BrowserWindow is constructed
            // (long before its renderer finishes loading): grab it and park
            // the window at the cursor so it SHOWS in place, never at the
            // default position.
            const created = remote.BrowserWindow.getAllWindows().find((w: any) => !before.has(w.id))
            if (!created) {
                return
            }
            this.target = created
            this.targetHostId = created.id
            created.setBounds({
                x: Math.round(b.x),
                y: Math.round(b.y),
                width: Math.round(b.width),
                height: Math.round(b.height),
            })
            try {
                created.setAlwaysOnTop(true)
            } catch {
                // cosmetic
            }
            // Hand focus back to the source once this target's plugin boots
            // (the host window takes focus at did-finish-load, mid-drag).
            try {
                window.localStorage.setItem(BOOST_KEY, JSON.stringify({
                    host: this.targetHostId,
                    source: this.mux.hostWindowId,
                    ts: Date.now(),
                }))
            } catch {
                // hint is best-effort
            }
            this.scheduleFollow()
        } catch {
            // No @electron/remote: card-only tear-off with post-release
            // window creation (the finish() fallback path).
        }
    }

    private scheduleFollow (): void {
        if (this.followTimer !== null || !this.target) {
            return
        }
        this.followTimer = setTimeout(() => {
            this.followTimer = null
            if (!this.target || !this.lastScreen) {
                return
            }
            const b = this.phantomBoundsAt(this.lastScreen)
            try {
                this.target.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) })
            } catch {
                this.destroyTarget()
            }
        }, FOLLOW_THROTTLE_MS)
    }

    /** Close a target that will not receive the tab (cancel / merge elsewhere). */
    private destroyTarget (): void {
        if (this.followTimer !== null) {
            clearTimeout(this.followTimer)
            this.followTimer = null
        }
        this.clearReturnTimer()
        this.forgetTarget(true)
    }

    private forgetTarget (destroy = false): void {
        if (destroy && this.target) {
            try {
                this.target.destroy()
            } catch {
                // already gone
            }
        }
        this.target = null
        this.targetHostId = null
    }

    /**
     * Target-side boot hook: if this window was created as a tear-off
     * target moments ago, give focus back to the dragging source window
     * (the host focuses every new window on load, which would yank focus
     * mid-drag).
     */
    private handBackFocusIfTarget (): void {
        try {
            const raw = window.localStorage.getItem(BOOST_KEY)
            if (!raw) {
                return
            }
            const hint = JSON.parse(raw)
            const mine = this.mux.hostWindowId
            if (hint?.host !== mine || Date.now() - (hint.ts ?? 0) > BOOST_TTL_MS) {
                return
            }
            window.localStorage.removeItem(BOOST_KEY)
            const remote: any = (require as any)('@electron/remote')
            remote.BrowserWindow.fromId(hint.source)?.focus?.()
        } catch {
            // focus handback is cosmetic
        }
    }

    /**
     * The anchor the cursor "holds" the window by: where the tab was
     * GRABBED, expressed as the mousedown's offset within the source
     * window. The target window keeps that same point under the cursor,
     * so the grabbed tab visually stays pinned to the mouse - the same
     * relative position it had in the source window's tab bar.
     */
    private rememberGrabOffset (pt: { x: number, y: number }): void {
        this.grabOffset = {
            x: clamp(pt.x - window.screenX, 40, Math.max(40, window.outerWidth - 40)),
            y: clamp(pt.y - window.screenY, 14, 80),
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
