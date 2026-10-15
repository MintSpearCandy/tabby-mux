// Deploy dist/ + package.json into an isolated Tabby instance's plugin dir.
//
// Discipline (verified the hard way across the plugin fleet):
//  - dist must be copied AS A SUBDIRECTORY next to package.json; flattening
//    dist/* into the package root breaks `main: dist/index.js` resolution and
//    the plugin silently never loads.
//  - never use bash cp with quoted Windows paths (trailing \" creates
//    malformed directories that break the whole plugin enumeration chain).
//
// Usage:
//   node scripts/updateDebugCfg.js                    # default target below
//   node scripts/updateDebugCfg.js --app              # also real Tabby (D:\App\Tabby)

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
    fs.rmSync(path.join(dst, 'dist'), { recursive: true, force: true })
    fs.cpSync(path.join(root, 'dist'), path.join(dst, 'dist'), { recursive: true })
    fs.copyFileSync(path.join(root, 'package.json'), path.join(dst, 'package.json'))
    console.log(`deployed -> ${dst}`)
}
