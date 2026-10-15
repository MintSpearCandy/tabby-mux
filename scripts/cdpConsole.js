// Attach to the main page target, enable Runtime, dump console messages that
// match a filter (default: plugin discovery/loading + errors).
// Usage: node scripts/cdpConsole.js [seconds] (CDP_PORT default 9242)

const PORT = process.env.CDP_PORT || '9242'
const SECONDS = parseInt(process.argv[2] || '1', 10)

async function main () {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const page = list.filter(t => t.type === 'page' && t.url.includes('index')).pop()
    if (!page) {
        console.error('no page target')
        process.exit(1)
    }
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    const interesting = /Found |Loading |Starting with plugins|error|Error|mux/i
    ws.onopen = () => {
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }))
        setTimeout(() => { console.log('--- window closed ---'); process.exit(0) }, SECONDS * 1000)
    }
    ws.onmessage = ev => {
        const msg = JSON.parse(ev.data)
        if (msg.method === 'Runtime.consoleAPICalled') {
            const text = msg.params.args.map(a => a.value ?? a.description ?? '').join(' ')
            if (interesting.test(text)) {
                console.log(`[${msg.params.type}] ${text.slice(0, 4000)}`)
            }
        }
        if (msg.method === 'Runtime.exceptionThrown') {
            console.log('[EXCEPTION]', JSON.stringify(msg.params.exceptionDetails).slice(0, 4000))
        }
    }
}

main().catch(e => { console.error(e.message); process.exit(1) })
