/**
 * Structural helpers for editing SplitTab recovery tokens in place.
 *
 * Token shapes (verified against a live 1.0.237 instance):
 *   window  { type: 'app:split-tab', ratios: number[], orientation: 'h'|'v', children: node[] }
 *   pane    { type: 'app:local-tab' | ..., profile: {...}, tabTitle, ... }
 * Any node carrying a `children` array is a container. After every structural
 * mutation the tree is normalized (empty containers dropped, single-child
 * containers hoisted) and every container's ratios are equalized - the
 * editor deliberately does not expose numeric ratio editing.
 */

export interface PaneInfo {
    /** Flat visual order of the pane within its window. */
    index: number
    /** Recovery type discriminator, e.g. 'app:local-tab'. */
    type: string
    profileName: string
    profileId: string | null
    cwd: string | null
    command: string | null
}

export function isContainer (node: any): boolean {
    return node && Array.isArray(node.children)
}

/** Depth-first leaves of a window token, in visual order. */
export function windowPanes (windowToken: any): PaneInfo[] {
    const panes: PaneInfo[] = []
    const walk = (node: any) => {
        if (isContainer(node)) {
            for (const child of node.children) {
                walk(child)
            }
            return
        }
        const profile = node?.profile ?? {}
        const options = profile.options ?? {}
        panes.push({
            index: panes.length,
            type: node?.type ?? '?',
            profileName: profile.name ?? node?.tabTitle ?? '?',
            profileId: profile.id ?? null,
            cwd: options.cwd ?? null,
            command: options.command ?? null,
        })
    }
    walk(windowToken)
    return panes
}

/** Human summary of a window token for list rows. */
export function windowSummary (windowToken: any): { panes: number, profile: string } {
    const panes = windowPanes(windowToken)
    return {
        panes: panes.length,
        profile: panes[0]?.profileName ?? '?',
    }
}

/** Recursively equalize ratios and hoist degenerate containers. */
export function normalize (node: any): void {
    if (!isContainer(node)) {
        return
    }
    node.children = node.children.filter(c => c)
    for (const child of node.children) {
        normalize(child)
    }
    // Drop empty nested containers; hoist single-child ones into the parent.
    const hoisted: any[] = []
    for (const child of node.children) {
        if (isContainer(child)) {
            if (!child.children.length) {
                continue
            }
            if (child.children.length === 1) {
                hoisted.push(child.children[0])
                continue
            }
        }
        hoisted.push(child)
    }
    node.children = hoisted
    node.ratios = node.children.map(() => 1 / Math.max(1, node.children.length))
    node.ratios.forEach(() => {})
}

function findAndMutateLeaf (
    node: any,
    targetFlatIndex: number,
    mutate: (parent: any, index: number, leaf: any) => boolean,
): boolean {
    if (!isContainer(node)) {
        return false
    }
    let flat = 0
    for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i]
        if (isContainer(child)) {
            const consumed = countLeaves(child)
            if (targetFlatIndex < flat + consumed) {
                if (findAndMutateLeaf(child, targetFlatIndex - flat, mutate)) {
                    return true
                }
            }
            flat += consumed
        } else {
            if (flat === targetFlatIndex) {
                return mutate(node, i, child)
            }
            flat++
        }
    }
    return false
}

function countLeaves (node: any): number {
    if (!isContainer(node)) {
        return 1
    }
    return node.children.reduce((sum: number, c: any) => sum + countLeaves(c), 0)
}

export function deletePane (windowToken: any, flatIndex: number): void {
    findAndMutateLeaf(windowToken, flatIndex, (parent, index) => {
        parent.children.splice(index, 1)
        parent.ratios.splice(index, 1)
        return true
    })
    normalize(windowToken)
}

export function duplicatePane (windowToken: any, flatIndex: number): void {
    findAndMutateLeaf(windowToken, flatIndex, (parent, index, leaf) => {
        const clone = JSON.parse(JSON.stringify(leaf))
        parent.children.splice(index + 1, 0, clone)
        parent.ratios.splice(index + 1, 0, parent.ratios[index] ?? 0.5)
        return true
    })
    normalize(windowToken)
}

/**
 * Appends a pane built from a profile. When the window already has panes,
 * the new one clones an existing pane token and swaps the profile (keeping
 * the recovery shape valid for non-local types too); otherwise a minimal
 * local-tab token is synthesized.
 */
export function appendPane (windowToken: any, profile: any): void {
    let token: any
    const panes = collectLeaves(windowToken)
    if (panes.length) {
        token = JSON.parse(JSON.stringify(panes[panes.length - 1]))
        token.profile = JSON.parse(JSON.stringify(profile))
        token.tabTitle = profile.name ?? token.tabTitle
        token.tabCustomTitle = ''
    } else {
        token = {
            type: 'app:local-tab',
            profile: JSON.parse(JSON.stringify(profile)),
            tabTitle: profile.name ?? '',
            tabCustomTitle: '',
            tabCustomTitleVisible: true,
            tabPinned: false,
        }
    }
    windowToken.children.push(token)
    normalize(windowToken)
}

function collectLeaves (node: any): any[] {
    if (!isContainer(node)) {
        return [node]
    }
    return node.children.flatMap(c => collectLeaves(c))
}

export function getRootOrientation (windowToken: any): 'h' | 'v' {
    return windowToken?.orientation === 'v' ? 'v' : 'h'
}

export function setRootOrientation (windowToken: any, orientation: 'h' | 'v'): void {
    windowToken.orientation = orientation
}

export function deepClone<T> (value: T): T {
    return JSON.parse(JSON.stringify(value))
}
