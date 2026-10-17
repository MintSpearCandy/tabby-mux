// Dispatch a REAL Chromium mouse click (full input pipeline: hit-test,
// focus, click synthesis) - unlike element.click(), this reproduces what
// a physical user click goes through.
// Usage: node scripts/cdpClick.js <x> <y>
//        node scripts/cdpClick.js --selector "<css selector>"
// The selector form resolves coordinates fresh right before clicking.
// (CDP_PORT default 9242)

const PORT = process.env.CDP_PORT || '9242'
const arg = process.argv[2]

async function main () {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const page = list.find(t => t.type === 'page' && t.url.includes('index'))
    const ws = new WebSocket(page.webSocketDebuggerUrl)

    const evalExpr = (expr) => new Promise((resolve, reject) => {
        const id = Math.floor(Math.random() * 1e6)
        const onMsg = ev => {
            const m = JSON.parse(ev.data)
            if (m.id === id) {
                ws.removeEventListener('message', onMsg)
                if (m.result?.exceptionDetails) {
                    reject(new Error(m.result.exceptionDetails.text))
                } else {
                    resolve(m.result?.result?.value)
                }
            }
        }
        ws.addEventListener('message', onMsg)
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }))
    })

    let x, y
    ws.onopen = async () => {
        try {
            if (arg === '--selector') {
                const selector = process.argv[3]
                const rect = JSON.parse(await evalExpr(
                    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'null'; ` +
                    `const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) return 'empty'; ` +
                    `return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }) })()`))
                if (!rect) { console.error('element not found:', selector); process.exit(1) }
                if (typeof rect === 'string') { console.error('element not visible:', selector); process.exit(1) }
                x = rect.x
                y = rect.y
            } else {
                x = parseFloat(arg)
                y = parseFloat(process.argv[3])
                if (!Number.isFinite(x) || !Number.isFinite(y)) {
                    console.error('usage: node scripts/cdpClick.js <x> <y> | --selector "<css>"')
                    process.exit(1)
                }
            }
            ws.send(JSON.stringify({ id: 1, method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x, y, button: 'left', clickCount: 1 } }))
            setTimeout(() => {
                ws.send(JSON.stringify({ id: 2, method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 } }))
            }, 120)
            setTimeout(() => { console.log(`clicked ${x},${y}`); process.exit(0) }, 400)
        } catch (e) {
            console.error(e.message)
            process.exit(1)
        }
    }
    ws.onerror = () => { console.error('ws error'); process.exit(1) }
    setTimeout(() => { console.error('timeout'); process.exit(1) }, 10000)
}

main()
