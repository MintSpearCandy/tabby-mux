// Deploy dist/ + package.json into an isolated Tabby instance's plugin dir.
//
// Discipline (verified the hard way across the plugin fleet):
//  - dist must be copied AS A SUBDIRECTORY next to package.json; flattening
//    dist/* into the package root breaks `main: dist/index.js` resolution and
//    the plugin silently never loads.
//  - never use bash cp with quoted Windows paths (trailing \" creates
//    malformed directories that break the whole plugin enumeration chain).
//  - the instance must NOT be running: loading a half-written dist/index.js
//    crashes the plugin and can trip Tabby's safe mode ("all third-party
//    plugins disabled"). Deployment swaps via a temp directory so the final
//    rename is as close to atomic as the filesystem allows.
//
// Usage:
//   node scripts/updateDebugCfg.js                    # default target below
//   node scripts/updateDebugCfg.js --app              # also real Tabby (D:\App\Tabby)

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

const targets = [
    path.join('D:', 'Env', 'TabbyEnv', 'instances', 'mux', 'data', 'plugins', 'node_modules', pkg.name),
]

if (process.argv.includes('--app')) {
    targets.push(path.join('D:', 'App', 'Tabby', 'data', 'plugins', 'node_modules', pkg.name))
}

if (!fs.existsSync(path.join(root, 'dist', 'index.js'))) {
    console.error('dist/index.js not found - run `npm run build` first')
    process.exit(1)
}

for (const dst of targets) {
    if (!fs.existsSync(path.dirname(dst))) {
        console.error(`SKIP (instance dir missing): ${dst}`)
        continue
    }
    // Refuse to deploy into a running instance.
    try {
        const instanceDir = dst.split('\\data\\')[0]
        const out = execSync(
            `powershell -NoProfile -Command "(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${instanceDir}*' } | Measure-Object).Count"`,
        ).toString().trim()
        if (parseInt(out, 10) > 0) {
            console.error(`ABORT (instance running, kill it first): ${instanceDir}`)
            process.exit(1)
        }
    } catch (e) {
        console.error('could not check running processes:', e.message)
        process.exit(1)
    }

    // Atomic-ish swap: stage the new dist next to the target, then rename.
    const staged = path.join(path.dirname(dst), `.${pkg.name}.staging`)
    fs.rmSync(staged, { recursive: true, force: true })
    fs.cpSync(path.join(root, 'dist'), staged, { recursive: true })
    const live = path.join(dst, 'dist')
    const old = path.join(dst, 'dist.old')
    fs.rmSync(old, { recursive: true, force: true })
    if (fs.existsSync(live)) {
        fs.renameSync(live, old)
    }
    try {
        fs.renameSync(staged, live)
    } catch (e) {
        // rename across states can fail oddly - fall back to a plain copy
        fs.cpSync(staged, live, { recursive: true })
        fs.rmSync(staged, { recursive: true, force: true })
    }
    fs.rmSync(old, { recursive: true, force: true })
    fs.copyFileSync(path.join(root, 'package.json'), path.join(dst, 'package.json'))
    console.log(`deployed -> ${dst}`)
}
