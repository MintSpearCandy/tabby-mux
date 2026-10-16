import { isLayoutContainer, MuxLayoutContainer, MuxLayoutNode, MuxPaneSpec } from './types'

/**
 * Layout-spec helpers: structural editing, capture from live SplitTab trees
 * (or legacy recovery tokens), and display summaries.
 *
 * Spec shapes (see types.ts): containers carry orientation + ratios, leaves
 * carry a MuxPaneSpec (profile reference or embedded copy). After every
 * structural mutation, degenerate containers are pruned and ratios are
 * equalized - numeric ratio editing is deliberately not exposed.
 */

// ============================================================================
// Display
// ============================================================================

export interface SpecPaneInfo {
    /** Path of child indexes from the root to this leaf. */
    path: number[]
    profileName: string
    badge: 'ref' | 'copy'
    cwd: string | null
    command: string | null
    profileId: string | null
}

export function specPanes (node: MuxLayoutNode, base: number[] = []): SpecPaneInfo[] {
    if (!isLayoutContainer(node)) {
        const pane: MuxPaneSpec = node.pane ?? { profileId: null, profile: null }
        const profile = pane.profile ?? {} as any
        const options = profile.options ?? {}
        return [{
            path: base,
            profileName: profile.name ?? pane.profileId ?? '?',
            badge: pane.profileId ? 'ref' : 'copy',
            cwd: options.cwd ?? null,
            command: options.command ?? null,
            profileId: pane.profileId,
        }]
    }
    return node.children.flatMap((child, i) => specPanes(child, [...base, i]))
}

export function specSummary (window: { layout: MuxLayoutContainer }): { panes: number, profile: string } {
    const panes = specPanes(window.layout)
    return {
        panes: panes.length,
        profile: panes[0]?.profileName ?? '?',
    }
}

// ============================================================================
// Structural editing (path-based)
// ============================================================================

export function nodeAtPath (root: MuxLayoutContainer, path: number[]): MuxLayoutNode | null {
    let node: MuxLayoutNode = root
    for (const index of path) {
        if (!isLayoutContainer(node) || index >= node.children.length) {
            return null
        }
        node = node.children[index]
    }
    return node
}

export function specPaneAt (root: MuxLayoutContainer, path: number[]): MuxPaneSpec | null {
    const node = nodeAtPath(root, path)
    return node && !isLayoutContainer(node) ? node.pane : null
}

export function equalize (node: MuxLayoutNode): void {
    if (!isLayoutContainer(node)) {
        return
    }
    node.children.forEach(equalize)
    node.ratios = node.children.map(() => 1 / Math.max(1, node.children.length))
}

/**
 * Prunes empty containers and hoists single-child containers into their
 * grandparent (the root container itself is always kept).
 */
export function normalizeSpec (root: MuxLayoutContainer): void {
    const prune = (node: MuxLayoutContainer) => {
        for (const child of node.children) {
            if (isLayoutContainer(child)) {
                prune(child)
            }
        }
        const kept: MuxLayoutNode[] = []
        for (const child of node.children) {
            if (isLayoutContainer(child)) {
                if (!child.children.length) {
                    continue
                }
                if (child.children.length === 1 && node !== root) {
                    kept.push(child.children[0])
                    continue
                }
                if (child.children.length === 1 && node === root) {
                    // hoist within root: keep container if orientation
                    // differs, else splice its child into root
                    if (child.orientation === node.orientation) {
                        kept.push(...child.children)
                        continue
                    }
                }
            }
            kept.push(child)
        }
        node.children = kept
        node.ratios = node.children.map(() => 1 / Math.max(1, node.children.length))
    }
    prune(root)
    equalize(root)
}

/**
 * Splits the leaf at `path` in `direction`: inserts a sibling pane after it,
 * wrapping the leaf into a new container when the parent's orientation does
 * not match.
 */
export function splitSpecAt (
    root: MuxLayoutContainer,
    path: number[],
    direction: 'h' | 'v',
    newPane: MuxPaneSpec,
): void {
    if (!path.length) {
        return
    }
    const parentPath = path.slice(0, -1)
    const index = path[path.length - 1]
    const parent = nodeAtPath(root, parentPath)
    if (!parent || !isLayoutContainer(parent)) {
        return
    }
    const leaf = parent.children[index]
    const fresh: MuxLayoutNode = { pane: newPane }
    if (parent.orientation === direction) {
        parent.children.splice(index + 1, 0, fresh)
    } else {
        const wrapper: MuxLayoutContainer = {
            orientation: direction,
            ratios: [0.5, 0.5],
            children: [leaf, fresh],
        }
        parent.children[index] = wrapper
    }
    normalizeSpec(root)
}

export function deleteSpecAt (root: MuxLayoutContainer, path: number[]): void {
    if (!path.length) {
        return
    }
    const parentPath = path.slice(0, -1)
    const index = path[path.length - 1]
    const parent = nodeAtPath(root, parentPath)
    if (!parent || !isLayoutContainer(parent)) {
        return
    }
    parent.children.splice(index, 1)
    normalizeSpec(root)
}

export function duplicateSpecAt (root: MuxLayoutContainer, path: number[]): void {
    if (!path.length) {
        return
    }
    const parentPath = path.slice(0, -1)
    const index = path[path.length - 1]
    const parent = nodeAtPath(root, parentPath)
    if (!parent || !isLayoutContainer(parent)) {
        return
    }
    const clone = JSON.parse(JSON.stringify(parent.children[index]))
    parent.children.splice(index + 1, 0, clone)
    normalizeSpec(root)
}

// ============================================================================
// Capture: live SplitTab tree / legacy recovery token -> spec
// ============================================================================

/**
 * Maps a live pane profile to a spec pane: reference (profileId) when a
 * registry profile with the same id still matches its identity fields,
 * embedded copy otherwise.
 */
export function paneSpecFromProfile (liveProfile: any, registry: any[]): MuxPaneSpec {
    if (liveProfile?.id) {
        const match = registry.find(p => p.id === liveProfile.id)
        if (match && profilesMatch(match, liveProfile)) {
            return { profileId: liveProfile.id, profile: null }
        }
    }
    return { profileId: null, profile: stripRuntimeFields(liveProfile) }
}

function profilesMatch (registryProfile: any, liveProfile: any): boolean {
    const a = registryProfile?.options ?? {}
    const b = liveProfile?.options ?? {}
    // cwd is deliberately ignored: the live pane carries the resolved launch
    // directory, not a user modification. restoreFromPTYID / __-prefixed
    // keys are session artifacts and never compared.
    return registryProfile?.name === liveProfile?.name
        && a.command === b.command
        && JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? [])
}

/** Drops bulky/runtime-only fields before embedding a profile copy. */
export function stripRuntimeFields (profile: any): any {
    if (!profile) {
        return null
    }
    const copy = JSON.parse(JSON.stringify(profile))
    delete copy.icon
    delete copy.color
    delete copy.weight
    delete copy.isBuiltin
    delete copy.isTemplate
    delete copy.disableDynamicTitle
    if (copy.options && typeof copy.options === 'object') {
        for (const key of Object.keys(copy.options)) {
            if (key.startsWith('__') || key === 'restoreFromPTYID') {
                delete copy.options[key]
            }
        }
    }
    return copy
}

/** Captures a live SplitContainer tree (SplitTab.root) as a layout spec. */
export function captureLayout (
    root: any,
    leafProfileOf: (tab: any) => any,
    registry: any[],
): MuxLayoutContainer {
    const walk = (node: any): MuxLayoutNode => {
        if (node && Array.isArray(node.children)) {
            return {
                orientation: node.orientation === 'v' ? 'v' : 'h',
                ratios: [...(node.ratios ?? [])],
                children: node.children.map(walk),
            }
        }
        return { pane: paneSpecFromProfile(leafProfileOf(node), registry) }
    }
    const spec = walk(root)
    if (!isLayoutContainer(spec)) {
        return { orientation: 'h', ratios: [1], children: [spec] }
    }
    return spec
}

/** Converts a legacy recovery-token window into a spec (boot migration). */
export function tokenToSpec (token: any, registry: any[]): MuxWindowSpecInput {
    const walk = (node: any): MuxLayoutNode => {
        if (node && Array.isArray(node.children)) {
            return {
                orientation: node.orientation === 'v' ? 'v' : 'h',
                ratios: [...(node.ratios ?? [])],
                children: node.children.map(walk),
            }
        }
        return { pane: paneSpecFromProfile(node?.profile, registry) }
    }
    const layout = walk(token)
    return { layout: isLayoutContainer(layout) ? layout : { orientation: 'h', ratios: [1], children: [layout] } }
}

export interface MuxWindowSpecInput {
    layout: MuxLayoutContainer
}

export function deepClone<T> (value: T): T {
    return JSON.parse(JSON.stringify(value))
}
