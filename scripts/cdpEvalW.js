// Multi-window CDP evaluator: picks a specific page target and pokes the
// Angular zone with an F13 keydown/keyup pair before evaluating, so awaits
// started outside the zone (this script) get driven forward by the next poke.
//
// Usage: node scripts/cdpEvalW.js [--win <targetIdPrefix|index>] "<expression>"
//   --win  select window by target id prefix, or by index into the index.html
//          page list (default: last one, like cdpEval.js)
//
// Environment: CDP_PORT (default 9242)

const PORT = process.env.CDP_PORT || '9242'

function parseArgs () {
    const args = process.argv.slice(2)
    let win = null
    const rest = []
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--win') {
            win = args[++i]
        } else {
            rest.push(args[i])
        }
    }
    return { win, expr: rest[0] }
}

async function main () {
    const { win, expr } = parseArgs()
    if (!expr) {
        console.error('usage: node scripts/cdpEvalW.js [--win <idPrefix|index>] "<expression>"')
        process.exit(1)
    }
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const pages = list.filter(t => t.type === 'page' && t.url.includes('index'))
    let page
    if (win === null) {
        page = pages[pages.length - 1]
    } else {
        // Prefix match first - target ids are hex and may be all-digits,
        // which would otherwise be mistaken for a list index.
        page = pages.find(t => t.id.startsWith(win)) ??
            (/^\d+$/.test(win) ? pages[Number(win)] : undefined)
    }
    if (!page) {
        console.error(`no matching page target (win=${win}); pages:`, pages.map(t => `${t.id.slice(0, 8)} ${t.title.slice(0, 30)}`))
        process.exit(1)
    }
    console.error(`target ${page.id.slice(0, 8)} "${page.title.slice(0, 40)}"`)

    const ws = new WebSocket(page.webSocketDebuggerUrl)
    let nextId = 1
    const pending = new Map()
    const send = (method, params) => {
        const id = nextId++
        ws.send(JSON.stringify({ id, method, params }))
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject })
            setTimeout(() => {
                if (pending.has(id)) {
                    pending.delete(id)
                    reject(new Error(`${method} timeout`))
                }
            }, 10000)
        })
    }
    ws.onmessage = ev => {
        const msg = JSON.parse(ev.data)
        if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id).resolve(msg)
            pending.delete(msg.id)
        }
    }
    const opened = new Promise((resolve, reject) => {
        ws.onopen = resolve
        ws.onerror = () => reject(new Error('ws error'))
    })
    await opened

    try {
        // Zone poke: a no-op chord-worth of key activity. Best effort - a
        // target mid-teardown may reject it, which is not fatal for reads.
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'F13', code: 'F13', windowsVirtualKeyCode: 124, nativeVirtualKeyCode: 124 })
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F13', code: 'F13', windowsVirtualKeyCode: 124, nativeVirtualKeyCode: 124 })
    } catch { }

    const r = await send('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
    })
    const res = r.result
    if (res.exceptionDetails) {
        console.log(JSON.stringify({ exception: res.exceptionDetails.exception?.description ?? res.exceptionDetails.text }, null, 2))
    } else {
        console.log(JSON.stringify(res.result.value, null, 2))
    }
    ws.close()
}

main().catch(e => { console.error(e.message); process.exit(1) })
