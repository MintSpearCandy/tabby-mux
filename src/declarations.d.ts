// Full compile-time shadow for 'tabby-settings': the host provides this
// module at runtime, and the pinned npm typings (1.0.231-nightly) lag the
// host (1.0.237) - e.g. EditProfileModalComponent is exported at runtime
// but missing from the package typings. Only the members this plugin
// consumes are declared here (BetterConfiger's documented pattern).
//
// NB: an ambient external module declaration in a non-module .d.ts SHADOWS
// the resolved package typings - keep this list in sync with our imports.
declare module 'tabby-settings' {
    export abstract class SettingsTabProvider {
        id: string
        icon: string
        title: string
        weight: number
        prioritized: boolean
        getComponentType (): any
    }

    export class EditProfileModalComponent<P> {
        partialProfile: any
        profileProvider: any
    }
}
