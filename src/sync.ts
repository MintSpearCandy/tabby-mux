import { Injectable, Injector, NgZone } from '@angular/core'
import { Subject } from 'rxjs'
import { BOOTSTRAP_DATA, BootstrapData } from 'tabby-core'
import { MuxSessionDTO, PullStashEntry } from './types'

/**
 * Cross-OS-window transport for the mux registry.
 *
 * Every Tabby OS window is its own renderer process with its own MuxService;
 * this service is the per-renderer endpoint of the mesh:
 *
 *  - BroadcastChannel('tabby-mux'): push channel (file:// pages share the
 *    origin, so the channel spans every open window). Alive hosts receive
 *    instantly; booting windows join when their JS evaluates.
 *  - localStorage('tabby-mux:pull-stash'): the SHARED handover queue. Window
 *    moves MUST go through it - a brand-new target renderer misses any
 *    channel message sent while it was still loading.
 *  - liveness: each host broadcasts `alive` every 5s (host timers keep
 *    running in background windows: BrowserWindow sets
 *    backgroundThrottling:false). A host silent for 16s is presumed dead -
 *    its windows (and their shells) died with the renderer - and gets
 *    reaped from every registry.
 */

export type MuxSyncEvent =
    | { t: 'hello', host: number }
    | { t: 'alive', host: number }
    | { t: 'snapshot', host: number, sessions: MuxSessionDTO[], global?: string | null }
    | { t: 'attach-session', host: number, sessionId: string }
    | { t: 'win-hosted', host: number, windowId: string }
    | { t: 'win-gone', host: number, windowId: string }
    | { t: 'focus-win', host: number, windowId: string }
    | { t: 'kill-win', host: number, windowId: string }
    | { t: 'check-stash' }

const CHANNEL_NAME = 'tabby-mux'
export const STASH_KEY = 'tabby-mux:pull-stash'
const ALIVE_INTERVAL_MS = 5_000
const HOST_TTL_MS = 16_000
/** Stash entries older than this are garbage on boot (never-claimed moves). */
const STASH_TTL_MS = 120_000

@Injectable({ providedIn: 'root' })
export class MuxSyncService {
    /** This renderer's OS window id (BOOTSTRAP_DATA `start` payload). */
    readonly hostWindowId: number
    /** When this renderer's JS world started - gates 'new' stash claims. */
    readonly bootTime = Date.now()

    /** Events received from other hosts (our own messages are not echoed). */
    readonly received$ = new Subject<MuxSyncEvent>()
    /** A host stopped broadcasting - its windows are gone for good. */
    readonly hostDied$ = new Subject<number>()

    private readonly zone: NgZone
    private readonly bootstrapData: BootstrapData
    private channel: BroadcastChannel | null = null
    private aliveTimer: any = null
    private started = false
    private readonly lastSeen = new Map<number, number>()

    constructor (injector: Injector) {
        this.zone = injector.get(NgZone)
        // BOOTSTRAP_DATA is an InjectionToken at runtime; the 1.0.231 typings
        // declare it as a plain string, hence the double cast.
        this.bootstrapData = injector.get<any>(BOOTSTRAP_DATA as any) as BootstrapData
        this.hostWindowId = this.bootstrapData?.windowID ?? 0
    }

    /** Live flag - a pulled window may become main if the original main closes. */
    get isMainWindow (): boolean {
        return !!(this.bootstrapData as any).isMainWindow
    }

    /** Hosts heard from recently, excluding self - move targets for the picker. */
    knownHosts (): number[] {
        const now = Date.now()
        return [...this.lastSeen.entries()]
            .filter(([host, seen]) => host !== this.hostWindowId && now - seen < HOST_TTL_MS)
            .map(([host]) => host)
    }

    /**
     * Opens the channel and starts the liveness heartbeat. `snapshotProvider`
     * is consulted to answer `hello` with the local registry view (sessions
     * plus the current global session id).
     */
    start (snapshotProvider: () => { sessions: MuxSessionDTO[], global: string | null } | null): void {
        if (this.started) {
            return
        }
        this.started = true
        this.snapshotProvider = snapshotProvider
        try {
            this.channel = new BroadcastChannel(CHANNEL_NAME)
        } catch {
            // No BroadcastChannel (unexpected in Electron): pull-out degrades
            // to stash-only, which still works for one-shot handovers.
            this.channel = null
        }
        if (this.channel) {
            this.channel.onmessage = ev => {
                const msg = ev.data as MuxSyncEvent
                if (!msg || typeof msg !== 'object') {
                    return
                }
                // BroadcastChannel never echoes own messages; the host check
                // is belt-and-suspenders for future runtime changes.
                if (msg.t !== 'check-stash') {
                    if (msg.host === this.hostWindowId) {
                        return
                    }
                    this.lastSeen.set(msg.host, Date.now())
                }
                this.received$.next(msg)
            }
        }
        this.send({ t: 'hello', host: this.hostWindowId })
        this.zone.runOutsideAngular(() => {
            this.aliveTimer = setInterval(() => this.tick(), ALIVE_INTERVAL_MS)
        })
    }

    private snapshotProvider: (() => { sessions: MuxSessionDTO[], global: string | null } | null) | null = null

    private tick (): void {
        this.send({ t: 'alive', host: this.hostWindowId })
        const now = Date.now()
        for (const [host, seen] of [...this.lastSeen.entries()]) {
            if (host !== this.hostWindowId && now - seen > HOST_TTL_MS) {
                this.lastSeen.delete(host)
                this.hostDied$.next(host)
            }
        }
    }

    /** Hello gets an immediate full snapshot so newcomers converge fast. */
    replySnapshot (): void {
        const dto = this.snapshotProvider?.() ?? null
        if (dto) {
            this.send({ t: 'snapshot', host: this.hostWindowId, sessions: dto.sessions, global: dto.global })
        }
    }

    send (ev: MuxSyncEvent): void {
        try {
            this.channel?.postMessage(ev)
        } catch {
            // a detached/failing channel must never take callers down
        }
    }

    // ------------------------------------------------------------------
    // Shared pull-stash (localStorage)
    // ------------------------------------------------------------------

    readStash (): PullStashEntry[] {
        try {
            const raw = window.localStorage.getItem(STASH_KEY)
            const list = raw ? JSON.parse(raw) : []
            return Array.isArray(list) ? list : []
        } catch {
            return []
        }
    }

    private writeStash (list: PullStashEntry[]): void {
        try {
            if (list.length) {
                window.localStorage.setItem(STASH_KEY, JSON.stringify(list))
            } else {
                window.localStorage.removeItem(STASH_KEY)
            }
        } catch {
            // quota/full - handover will time out on the source side
        }
    }

    pushStash (entry: PullStashEntry): void {
        const list = this.readStash().filter(e => e.id !== entry.id)
        list.push(entry)
        this.writeStash(list)
    }

    removeStashEntry (id: string): void {
        this.writeStash(this.readStash().filter(e => e.id !== id))
    }

    /** Drops entries too old to ever be claimed (boot-time garbage pass). */
    gcStash (): void {
        const now = Date.now()
        this.writeStash(this.readStash().filter(e => now - (e.ts ?? 0) < STASH_TTL_MS))
    }

    /**
     * Atomically-ish claims every entry matching `match`. localStorage has no
     * cross-renderer transactions; the re-read/write-back below narrows the
     * race to near zero, and a double-claim at worst attaches the same PTY
     * twice (visible immediately, no data loss).
     */
    claimStashEntries (match: (e: PullStashEntry) => boolean): PullStashEntry[] {
        const before = window.localStorage.getItem(STASH_KEY)
        const list = this.readStash()
        const mine = list.filter(e => {
            try {
                return match(e)
            } catch {
                return false
            }
        })
        if (!mine.length) {
            return []
        }
        const taken = new Set(mine.map(e => e.id))
        const rest = list.filter(e => !taken.has(e.id))
        // Someone rewrote the stash between our read and write - merge their
        // additions back rather than clobbering (single retry).
        const current = window.localStorage.getItem(STASH_KEY)
        if (current !== before && current !== null) {
            try {
                const fresh = JSON.parse(current)
                if (Array.isArray(fresh)) {
                    for (const e of fresh) {
                        if (e?.id && !taken.has(e.id) && !rest.some(x => x.id === e.id)) {
                            rest.push(e)
                        }
                    }
                }
            } catch {
                // keep our filtered list
            }
        }
        this.writeStash(rest)
        return mine
    }
}
