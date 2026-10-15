// No-GUI load check: stub the host-provided modules (webpack externals),
// require() the built bundle, and assert the NgModule default export comes
// out alive. Reproduces the "plugin silently disappears" class of failures
// without launching Tabby.
//
// The tabby-core stub is a strict proxy: any export the bundle touches that
// is not stubbed below throws, so the stub list stays honest.

const fs = require('fs')
const Module = require('module')
const path = require('path')

const root = path.join(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const distEntry = path.join(root, 'dist', 'index.js')

if (!fs.existsSync(distEntry)) {
    console.error('dist/index.js not found - run `npm run build` first')
    process.exit(1)
}

// ---- minimal runtime stand-ins -------------------------------------------

class StubSubject {
    constructor () { this.observers = [] }
    subscribe (fn) { this.observers.push(fn); return { unsubscribe: () => {} } }
    next (v) { for (const o of this.observers) { o(v) } }
}
class StubSubscription { unsubscribe () {} }

function stubClass (name) {
    const cls = class {}
    Object.defineProperty(cls, 'name', { value: name })
    return cls
}

const tabbyCoreExports = {
    // base classes extended / instantiated by the plugin
    ConfigProvider: stubClass('ConfigProvider'),
    HotkeyProvider: stubClass('HotkeyProvider'),
    CommandProvider: stubClass('CommandProvider'),
    ToolbarButtonProvider: stubClass('ToolbarButtonProvider'),
    Command: stubClass('Command'),
    PromptModalComponent: stubClass('PromptModalComponent'),
    SplitTabComponent: stubClass('SplitTabComponent'),
    // services referenced through the injector (constructor bodies only)
    AppService: stubClass('AppService'),
    ConfigService: stubClass('ConfigService'),
    HotkeysService: stubClass('HotkeysService'),
    ProfilesService: stubClass('ProfilesService'),
    TabsService: stubClass('TabsService'),
    LocaleService: stubClass('LocaleService'),
}
tabbyCoreExports.default = { ...tabbyCoreExports }

function strictProxy (moduleName, exports_) {
    return new Proxy({}, {
        get (_t, prop) {
            if (prop === '__esModule') { return true }
            if (prop in exports_) { return exports_[prop] }
            throw new Error(`${moduleName}: export "${String(prop)}" used by the bundle but not stubbed in smokeLoad.js`)
        },
    })
}

const angularFactory = () => (...args) => (target => target)

const stubs = {
    'tabby-core': strictProxy('tabby-core', tabbyCoreExports),
    'tabby-terminal': strictProxy('tabby-terminal', {
        BaseTerminalTabComponent: stubClass('BaseTerminalTabComponent'),
    }),
    'rxjs': { Subject: StubSubject, Subscription: StubSubscription },
    '@ng-bootstrap/ng-bootstrap': { NgbModal: stubClass('NgbModal') },
}

const origLoad = Module._load
Module._load = function (request, parent, isMain) {
    if (stubs[request]) { return stubs[request] }
    if (/^@angular\//.test(request)) {
        return new Proxy({}, { get: (_t, prop) => prop === '__esModule' ? true : angularFactory() })
    }
    return origLoad.apply(this, arguments)
}

// ---- load & assert --------------------------------------------------------

let mod
try {
    mod = origLoad.call(Module, distEntry, null, false)
} catch (e) {
    console.error(`SMOKE FAIL: ${pkg.name} threw during module evaluation:`)
    console.error(e)
    process.exit(1)
}

const problems = []
if (typeof mod.default !== 'function') {
    problems.push(`default export is ${typeof mod.default}, expected NgModule class`)
}
for (const named of ['MuxService', 'MUX_COMMANDS']) {
    if (!(named in mod)) {
        problems.push(`missing named export "${named}"`)
    }
}
if (typeof mod.MUX_COMMANDS?.length !== 'number' || mod.MUX_COMMANDS.length < 20) {
    problems.push(`MUX_COMMANDS looks wrong (${mod.MUX_COMMANDS?.length} entries)`)
}

if (problems.length) {
    console.error(`SMOKE FAIL: ${pkg.name}`)
    for (const p of problems) { console.error(`  - ${p}`) }
    process.exit(1)
}

console.log(`SMOKE OK: ${pkg.name} loaded, default export + ${mod.MUX_COMMANDS.length} commands`)
