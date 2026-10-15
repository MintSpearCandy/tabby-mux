// Minimal CDP evaluator: connects to the debug port, runs a JS expression in
// the main window page target, prints the JSON result.
//
// Usage: node scripts/cdpEval.js "<expression>"      (CDP_PORT=9242 default)
//        CDP_PORT=9242 node scripts/cdpEval.js "1+1"

const PORT = process.env.CDP_PORT || '9242'

async function main () {
    const expr = process.argv[2]
    if (!expr) {
        console.error('usage: node scripts/cdpEval.js "<expression>"')
        process.exit(1)
    }
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const page = list.filter(t => t.type === 'page' && t.url.includes('index')).pop()
    if (!page) {
        console.error('no main window page target found; targets:', list.map(t => `${t.type}:${t.url}`))
        process.exit(1)
    }
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    const done = new Promise((resolve, reject) => {
        ws.onopen = () => {
            ws.send(JSON.stringify({
                id: 1,
                method: 'Runtime.evaluate',
                params: {
                    expression: expr,
                    returnByValue: true,
                    awaitPromise: true,
                },
            }))
        }
        ws.onerror = e => reject(new Error('ws error'))
        ws.onmessage = ev => {
            const msg = JSON.parse(ev.data)
            if (msg.id === 1) {
                const r = msg.result
                if (r.exceptionDetails) {
                    resolve({ exception: r.exceptionDetails.exception?.description
                        ?? r.exceptionDetails.text })
                } else {
                    resolve(r.result.value)
                }
                ws.close()
            }
        }
        setTimeout(() => reject(new Error('CDP timeout')), 20000)
    })
    console.log(JSON.stringify(await done, null, 2))
}

main().catch(e => { console.error(e.message); process.exit(1) })
