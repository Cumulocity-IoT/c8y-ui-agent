// screenshot: a page of a preview in headless Chromium, as a PNG file, with what went wrong while it loaded: console
// errors, failed requests, and the emulator's gaps. Evidence level `observed`: before and after screenshots.
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isExpectedMiss } from '@cumulocity-iot/ui-sdk'
import type { GapRecord } from '@cumulocity-iot/ui-sdk'
import { chromium } from 'playwright-core'
import type { Browser, Request } from 'playwright-core'
import { WorkbenchError } from './target'
import { errorMessage } from './util'

export interface ScreenshotOptions {
  /** The page to open: the preview's URL. */
  url: string
  /** The preview's emulator, for its gap report. */
  mockUrl?: string
  /** Route in the app: `#/device/1`, `/device/1` or `device/1`. Default: the URL as it is. */
  path?: string
  /** CSS selector that must be visible before the screenshot. */
  waitFor?: string
  /** CSS selector of the element to capture instead of the viewport. */
  selector?: string
  fullPage?: boolean
  width?: number
  height?: number
  /** Browser language, which the shell uses for its texts (default `en`). */
  language?: string
  /** Wait for the page and `waitFor`, in milliseconds (default 30 000). */
  timeout?: number
  /** The PNG file to write. */
  file: string
  signal?: AbortSignal
}

export interface FailedRequest {
  method: string
  url: string
  /** HTTP status, or the browser's error (`net::ERR_…`) when no response came. */
  status: number | string
}

export interface Screenshot {
  file: string
  /** The page's URL when the screenshot was taken. */
  url: string
  title: string
  /** False when requests or DOM changes still ran after 15 s: the page may not show its final state. */
  settled: boolean
  /** Console errors and uncaught exceptions. */
  errors: string[]
  /** Responses with status 400 or more and requests without a response, except those a fresh tenant answers with 404 too. */
  failedRequests: FailedRequest[]
  /** Requests the emulator could not answer as a tenant would, while the page loaded, except expected ones. */
  gaps: GapRecord[]
}

/** The page's URL with `path` as the route: the shell routes by the URL's hash. */
export function pageUrl(url: string, path?: string): string {
  if (!path)
    return url
  const u = new URL(url)
  u.hash = path.startsWith('#') ? path.slice(1) : `/${path.replace(/^\/+/, '')}`
  return u.toString()
}

// Settled: no HTTP request in flight and no DOM change for QUIET_MS. Realtime uses a WebSocket, which is not a request.
// The shell slides its navigator in about 0.7 s after its last request, with few DOM changes in between: hence 1 s.
// A CSS animation or transition that is still running is finished at the capture (`animations: 'disabled'`).
const QUIET_MS = 1000
const SETTLE_MS = 15_000
// The time of the last DOM change, from an observer installed before the page's scripts run.
const OBSERVE_DOM = `(() => {
  window.__workbenchLastChange = performance.now()
  new MutationObserver(() => { window.__workbenchLastChange = performance.now() })
    .observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
})()`
const SINCE_DOM_CHANGE = 'performance.now() - (window.__workbenchLastChange ?? 0)'
// The console reports each failed request as an error too; failedRequests has them.
const RESOURCE_ERROR = /^Failed to load resource:/

/** One headless Chromium for all screenshots, started on first use: Playwright's own, else the installed Chrome. */
export class Screenshots {
  private browser?: Promise<Browser>
  private next = 1

  constructor(private readonly dir = join(tmpdir(), 'c8y-ui-workbench-screenshots')) {}

  /** A file in the screenshot directory: `<prefix>-<n>.png`, or `<name>.png`. */
  file(prefix: string, name?: string): string {
    mkdirSync(this.dir, { recursive: true })
    const base = name ? name.replace(/[^\w.-]+/g, '-').replace(/\.png$/i, '') : `${prefix}-${this.next++}`
    return resolve(this.dir, `${base}.png`)
  }

  private launch(): Promise<Browser> {
    if (!this.browser) {
      const launching: Promise<Browser> = chromium.launch().catch(() => chromium.launch({ channel: 'chrome' })).then((browser) => {
        // A browser that crashed or was killed is started again on the next screenshot.
        browser.once('disconnected', () => {
          if (this.browser === launching)
            this.browser = undefined
        })
        return browser
      }, (error: unknown) => {
        this.browser = undefined
        throw new WorkbenchError(`no browser for screenshots: install Google Chrome, or run \`npx playwright-core install chromium-headless-shell\` (${errorMessage(error).split('\n')[0]})`)
      })
      this.browser = launching
    }
    return this.browser
  }

  async take(options: ScreenshotOptions): Promise<Screenshot> {
    options.signal?.throwIfAborted()
    const browser = await this.launch()
    const language = options.language ?? 'en'
    const context = await browser.newContext({
      viewport: { width: options.width ?? 1440, height: options.height ?? 900 },
      locale: language,
      extraHTTPHeaders: { 'Accept-Language': language },
    })
    const close = (): void => void context.close().catch(() => {})
    if (options.signal?.aborted) {
      close()
      options.signal.throwIfAborted()
    }
    options.signal?.addEventListener('abort', close, { once: true })
    const timeout = options.timeout ?? 30_000
    const errors: string[] = []
    const failedRequests: FailedRequest[] = []
    const inflight = new Set<Request>()
    let lastActivity = Date.now()
    const failed = (request: Request, status: number | string): void => {
      if (!isExpectedMiss({ path: new URL(request.url()).pathname }))
        failedRequests.push({ method: request.method(), url: request.url(), status })
    }
    try {
      const page = await context.newPage()
      await page.addInitScript(OBSERVE_DOM)
      page.setDefaultTimeout(timeout)
      page.on('console', (message) => {
        if (message.type() === 'error' && !RESOURCE_ERROR.test(message.text()))
          errors.push(message.text())
      })
      page.on('pageerror', error => errors.push(error.stack ?? error.message))
      page.on('request', (request) => {
        inflight.add(request)
        lastActivity = Date.now()
      })
      page.on('requestfinished', (request) => {
        inflight.delete(request)
        lastActivity = Date.now()
      })
      page.on('requestfailed', (request) => {
        inflight.delete(request)
        lastActivity = Date.now()
        failed(request, request.failure()?.errorText ?? 'failed')
      })
      page.on('response', (response) => {
        if (response.status() >= 400)
          failed(response.request(), response.status())
      })

      const started = Date.now()
      await page.goto(pageUrl(options.url, options.path), { waitUntil: 'load', timeout })
      if (options.waitFor)
        await page.locator(options.waitFor).first().waitFor({ state: 'visible', timeout })
      let settled = false
      for (const end = Date.now() + SETTLE_MS; Date.now() < end; await page.waitForTimeout(100)) {
        options.signal?.throwIfAborted()
        if (inflight.size === 0 && Date.now() - lastActivity >= QUIET_MS && await page.evaluate<number>(SINCE_DOM_CHANGE) >= QUIET_MS) {
          settled = true
          break
        }
      }
      // Web fonts that are still loading would render as fallback fonts. A string: tsconfig has no DOM types.
      await page.evaluate('document.fonts.ready.then(() => undefined)')
      const target = options.selector ? page.locator(options.selector).first() : page
      await target.screenshot({ path: options.file, ...(options.selector ? {} : { fullPage: options.fullPage ?? false }), animations: 'disabled' })
      return {
        file: options.file,
        url: page.url(),
        title: await page.title(),
        settled,
        errors,
        failedRequests,
        gaps: options.mockUrl ? await gapsSince(options.mockUrl, started) : [],
      }
    }
    catch (error) {
      options.signal?.throwIfAborted()
      throw error
    }
    finally {
      options.signal?.removeEventListener('abort', close)
      close()
    }
  }

  async close(): Promise<void> {
    const browser = this.browser
    this.browser = undefined
    await (await browser?.catch(() => undefined))?.close()
  }
}

/** The emulator's unexpected gaps seen since `since` (ms); none when the emulator does not answer. */
async function gapsSince(mockUrl: string, since: number): Promise<GapRecord[]> {
  try {
    const response = await fetch(`${mockUrl}/_mock/gaps?since=${since}`, { signal: AbortSignal.timeout(5000) })
    if (!response.ok)
      return []
    const { gaps } = await response.json() as { gaps?: GapRecord[] }
    return (gaps ?? []).filter(gap => !gap.expected)
  }
  catch {
    return []
  }
}
