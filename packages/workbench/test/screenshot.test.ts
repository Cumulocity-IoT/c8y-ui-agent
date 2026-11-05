import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkLanguage, pageUrl, Screenshots, tooLargeToInline } from '../src/screenshot'

// A page that settles late: 300 ms after its requests, it starts a 2 s CSS transition, which changes no DOM. When the
// transition ends, it appends a 1000 px block and sets its title: the capture finishes the transition and must include
// what follows it. A spinner runs forever and must not keep the page from settling. A request the page cancels itself is
// no failure; a 500 on a path that a fresh tenant answers with 404 is one.
const PAGE = `<!doctype html><html><head><title>loading</title><style>
  body { margin: 0; }
  #box { width: 100px; height: 50px; background: red; transition: width 2000ms linear; }
  #box.wide { width: 300px; }
  #spinner { width: 10px; height: 10px; animation: spin 1s linear infinite; }
  #late { height: 1000px; margin: 0; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style></head><body>
<div id="spinner"></div><div id="box"></div>
<script>
  console.error('boom')
  const cancel = new AbortController()
  fetch('/slow', { signal: cancel.signal }).catch(() => {})
  setTimeout(() => cancel.abort(), 50)
  fetch('/tenant/options/configuration/system.support.url?status=500')
  Promise.all([fetch('/missing'), fetch('/tenant/options/configuration/system.support.url')]).then(() => setTimeout(() => {
    const box = document.getElementById('box')
    box.addEventListener('transitionend', () => {
      document.title = ['done', location.hash, navigator.language].join(' ')
      const late = document.createElement('p')
      late.id = 'late'
      late.textContent = navigator.language
      document.body.append(late)
    })
    requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add('wide')))
  }, 300))
</script></body></html>`

// A web font that never loads, used after the load event.
const FONT_PAGE = `<!doctype html><html><head><style>
  @font-face { font-family: never; src: url(/hang); }
  .late { font-family: never; }
</style></head><body><p id="text">text</p>
<script>addEventListener('load', () => setTimeout(() => document.getElementById('text').className = 'late'))</script>
</body></html>`

const GAPS = {
  gaps: [
    { kind: 'unknown-endpoint', method: 'GET', path: '/service/x', status: 404, count: 1, firstAt: 1, lastAt: 2, expected: false },
    { kind: 'not-found', method: 'GET', path: '/tenant/options/configuration/system.support.url', status: 404, count: 1, firstAt: 1, lastAt: 2, expected: true },
  ],
}

/** Width and height from a PNG's header. */
function size(file: string): [number, number] {
  const png = readFileSync(file)
  return [png.readUInt32BE(16), png.readUInt32BE(20)]
}

describe('pageUrl', () => {
  it('sets the route as the hash', () => {
    const url = 'http://localhost:1/apps/cockpit/index.html?remotes=%7B%7D'
    expect(pageUrl(url)).toBe(url)
    expect(pageUrl(url, '#/device/1')).toBe(`${url}#/device/1`)
    expect(pageUrl(url, '/device/1')).toBe(`${url}#/device/1`)
    expect(pageUrl(url, 'device/1')).toBe(`${url}#/device/1`)
    expect(pageUrl(`${url}#/home`, 'favorites')).toBe(`${url}#/favorites`)
  })
})

describe('Screenshots', () => {
  let server: Server
  let url: string
  let dir: string
  let gapsSince: string | null = null
  const screenshots = new Screenshots(join(tmpdir(), 'workbench-screenshot-unused'))

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'workbench-screenshot-'))
    server = createServer((req, res) => {
      const { pathname, searchParams } = new URL(req.url ?? '/', 'http://localhost')
      if (pathname === '/app/index.html')
        return res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE)
      if (pathname === '/app/font.html')
        return res.writeHead(200, { 'content-type': 'text/html' }).end(FONT_PAGE)
      if (pathname === '/slow')
        return setTimeout(() => res.writeHead(200).end(), 1000)
      if (pathname === '/hang')
        return
      if (searchParams.get('status') === '500')
        return res.writeHead(500).end()
      if (pathname === '/_mock/gaps') {
        gapsSince = searchParams.get('since')
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(GAPS))
      }
      res.writeHead(404).end()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterAll(async () => {
    await screenshots.close()
    server.closeAllConnections()
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('waits until the page settles and reports errors, failed requests and unexpected gaps', async () => {
    const started = Date.now()
    const shot = await screenshots.take({ url: `${url}/app/index.html`, mockUrl: url, path: '/home', width: 800, height: 600, fullPage: true, file: join(dir, 'page.png') })
    expect(shot.settled).toBe(true)
    expect(shot.title).toBe('done #/home en')
    expect(shot.url).toBe(`${url}/app/index.html#/home`)
    expect(shot.errors).toEqual(['boom'])
    expect(shot.failedRequests).toEqual(expect.arrayContaining([
      { method: 'GET', url: `${url}/missing`, status: 404 },
      { method: 'GET', url: `${url}/tenant/options/configuration/system.support.url?status=500`, status: 500 },
    ]))
    expect(shot.failedRequests).toHaveLength(2)
    expect(shot.gaps.map(gap => gap.path)).toEqual(['/service/x'])
    expect(Number(gapsSince)).toBeGreaterThanOrEqual(started)
    // Spinner, box and the block that follows the transition.
    expect(size(shot.file)).toEqual([800, 1060])
  }, 30_000)

  it('captures the viewport', async () => {
    const shot = await screenshots.take({ url: `${url}/app/index.html`, width: 800, height: 600, file: join(dir, 'viewport.png') })
    expect(size(shot.file)).toEqual([800, 600])
  }, 30_000)

  it('captures one element after waitFor, in the given language', async () => {
    const shot = await screenshots.take({ url: `${url}/app/index.html`, waitFor: '#late', selector: '#box', language: 'de', file: join(dir, 'box.png') })
    expect(shot.title).toBe('done de')
    expect(shot.gaps).toEqual([])
    expect(size(shot.file)).toEqual([300, 50])
  }, 30_000)

  it('gives up on a web font that never loads within the timeout', async () => {
    const started = Date.now()
    await expect(screenshots.take({ url: `${url}/app/font.html`, timeout: 2000, file: join(dir, 'font.png') })).rejects.toThrow(/fonts|Timeout/)
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 30_000)

  it('rejects once aborted', async () => {
    await expect(screenshots.take({ url: `${url}/app/index.html`, file: join(dir, 'no.png'), signal: AbortSignal.abort(new Error('stop')) })).rejects.toThrow('stop')
    // While the page opens, loads and settles. Closing the context alone left newPage() pending forever.
    for (const delay of [0, 25, 50, 100, 200, 800]) {
      const abort = new AbortController()
      const run = screenshots.take({ url: `${url}/app/index.html`, file: join(dir, 'no.png'), signal: abort.signal })
      setTimeout(() => abort.abort(new Error(`stopped after ${delay} ms`)), delay)
      await expect(run).rejects.toThrow(`stopped after ${delay} ms`)
    }
  }, 30_000)

  it('starts the browser again after it closed', async () => {
    await screenshots.close()
    const shot = await screenshots.take({ url: `${url}/app/index.html`, width: 400, height: 300, file: join(dir, 'again.png') })
    expect(size(shot.file)).toEqual([400, 300])
  }, 30_000)

  it('rejects a language that is not a language tag', async () => {
    expect(() => checkLanguage('de-AT')).not.toThrow()
    expect(() => checkLanguage('not a language')).toThrow('language tag')
    await expect(screenshots.take({ url: `${url}/app/index.html`, language: '!', file: join(dir, 'no.png') })).rejects.toThrow('language tag')
  })

  it('writes to a new private directory by default', () => {
    const file = new Screenshots().file('preview-1')
    try {
      expect(dirname(file).startsWith(join(tmpdir(), 'c8y-ui-workbench-screenshots-'))).toBe(true)
      expect(statSync(dirname(file)).mode & 0o777).toBe(0o700)
    }
    finally {
      rmSync(dirname(file), { recursive: true, force: true })
    }
  })

  it('names files after the preview or the given name', () => {
    const named = new Screenshots(dir)
    expect(named.file('preview-1')).toBe(join(dir, 'preview-1-1.png'))
    expect(named.file('preview-1')).toBe(join(dir, 'preview-1-2.png'))
    expect(named.file('preview-1', 'empty state.png')).toBe(join(dir, 'empty-state.png'))
    expect(named.file('preview-1', '../../etc/x')).toBe(join(dir, '..-..-etc-x.png'))
  })
})

describe('tooLargeToInline', () => {
  const png = (width: number, height: number, bytes = 100): Buffer => {
    const buffer = Buffer.alloc(bytes)
    buffer.writeUInt32BE(width, 16)
    buffer.writeUInt32BE(height, 20)
    return buffer
  }
  it('accepts images up to 8000 px a side and 3.75 MB', () => {
    expect(tooLargeToInline(png(1440, 8000))).toBeUndefined()
    expect(tooLargeToInline(png(1440, 8001))).toMatch('1440x8001 px')
    expect(tooLargeToInline(png(1440, 900, 3_750_001))).toMatch('3.8 MB')
  })
})
