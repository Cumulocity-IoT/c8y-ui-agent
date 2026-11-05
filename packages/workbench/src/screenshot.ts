// screenshot: a page of a preview in headless Chromium, as a PNG file, with what went wrong while it loaded: console
// errors, failed requests, and the emulator's gaps. Evidence level `observed`: before and after screenshots.
import { mkdirSync, mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isExpectedMiss } from '@cumulocity-iot/ui-sdk'
import type { GapRecord } from '@cumulocity-iot/ui-sdk'
import { chromium } from 'playwright-core'
import type { Browser, BrowserContext, Request } from 'playwright-core'
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
  /** Wait for the page, `waitFor` and the capture, in milliseconds (default 30 000); the page settles for 15 s at most. */
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
  /** False when requests, DOM changes or animations still ran after 15 s: the page may not show its final state. */
  settled: boolean
  /** Console errors and uncaught exceptions. */
  errors: string[]
  /**
   * Responses with status 400 or more and requests without a response, except 404 and 405 responses a fresh tenant
   * gives too and requests the page canceled itself (`net::ERR_ABORTED`).
   */
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

/** Viewport bounds, for the MCP tool and the CLI. */
export const VIEWPORT = { width: { min: 320, max: 3840, default: 1440 }, height: { min: 240, max: 2160, default: 900 } }
/** The largest PNG an MCP result carries inline: the model API rejects images over 8000 px a side or 5 MB (base64). */
export const INLINE_LIMIT = { pixels: 8000, bytes: 3_750_000 }

/** Why a PNG is too large to return inline, or undefined. */
export function tooLargeToInline(png: Buffer): string | undefined {
  const [width, height] = [png.readUInt32BE(16), png.readUInt32BE(20)]
  if (width > INLINE_LIMIT.pixels || height > INLINE_LIMIT.pixels || png.length > INLINE_LIMIT.bytes)
    return `${width}x${height} px, ${(png.length / 1e6).toFixed(1)} MB: over ${INLINE_LIMIT.pixels} px a side or ${INLINE_LIMIT.bytes / 1e6} MB`
  return undefined
}

/** Throws unless `language` is a BCP 47 language tag such as `en` or `de-AT`. */
export function checkLanguage(language: string): void {
  try {
    Intl.getCanonicalLocales(language)
  }
  catch {
    throw new WorkbenchError(`language ${JSON.stringify(language)} is not a language tag such as "en" or "de-AT"`)
  }
}

// Settled: no HTTP request in flight and no DOM change for QUIET_MS, then no running animation that ends. Realtime uses
// a WebSocket, which is not a request. The shell slides its navigator in about 0.7 s after its last request, with few
// DOM changes in between: hence 1 s.
// Animations that end are finished on the page, then the page must be quiet again: what their end handlers add is part
// of the final state. `animations: 'disabled'` at the capture would finish them too, but their end events would run
// after the capture measures the page. Infinite animations (spinners) are reset at the capture.
const QUIET_MS = 1000
const SETTLE_MS = 15_000
// The time of the last DOM change, from an observer installed before the page's scripts run.
const OBSERVE_DOM = `(() => {
  window.__workbenchLastChange = performance.now()
  new MutationObserver(() => { window.__workbenchLastChange = performance.now() })
    .observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
})()`
const SINCE_DOM_CHANGE = 'performance.now() - (window.__workbenchLastChange ?? 0)'
// Finishes running animations that end; returns how many.
const FINISH_ANIMATIONS = `document.getAnimations().filter((animation) => {
  if (animation.playState !== 'running' || !Number.isFinite(animation.effect?.getComputedTiming().endTime))
    return false
  try { animation.finish(); return true } catch { return false }
}).length`
// The console reports each failed request as an error too; failedRequests has them.
const RESOURCE_ERROR = /^Failed to load resource:/
// The browser that matches playwright-core, for the install hint.
const PLAYWRIGHT_VERSION = (createRequire(import.meta.url)('playwright-core/package.json') as { version: string }).version

/** One headless Chromium for all screenshots, started on first use: Playwright's own, else the installed Chrome. */
export class Screenshots {
  private browser?: Promise<Browser>
  private next = 1

  /** `dir`: where screenshots go. Default: a new private directory in the system temp directory, on first use. */
  constructor(private dir?: string) {}

  /** A file in the screenshot directory: `<prefix>-<n>.png`, or `<name>.png`. */
  file(prefix: string, name?: string): string {
    // A fresh directory (mode 0700): a fixed path in a shared /tmp could be another user's, with planted symlinks.
    this.dir ||= mkdtempSync(join(tmpdir(), 'c8y-ui-workbench-screenshots-'))
    mkdirSync(this.dir, { recursive: true })
    const base = name ? name.replace(/[^\w.-]+/g, '-').replace(/\.png$/i, '').slice(0, 100) : `${prefix}-${this.next++}`
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
        if (this.browser === launching)
          this.browser = undefined
        throw new WorkbenchError(`no browser for screenshots: install Google Chrome, or run \`npx playwright-core@${PLAYWRIGHT_VERSION} install chromium-headless-shell\` (${errorMessage(error).split('\n')[0]})`)
      })
      this.browser = launching
    }
    return this.browser
  }

  async take(options: ScreenshotOptions): Promise<Screenshot> {
    const { signal } = options
    signal?.throwIfAborted()
    const language = options.language ?? 'en'
    checkLanguage(language)
    const browser = await this.launch()
    const context = await browser.newContext({
      viewport: { width: options.width ?? VIEWPORT.width.default, height: options.height ?? VIEWPORT.height.default },
      locale: language,
      extraHTTPHeaders: { 'Accept-Language': language },
    })
    // On abort, reject at once and close the context. Closing the context does not reject every pending Playwright
    // call: `newPage()` never returns when the context closes while it runs.
    let onAbort = (): void => {}
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal?.reason)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    const capture = this.capture(context, options)
    capture.catch(() => {})
    try {
      signal?.throwIfAborted()
      return await Promise.race([capture, aborted])
    }
    finally {
      signal?.removeEventListener('abort', onAbort)
      void context.close().catch(() => {})
    }
  }

  private async capture(context: BrowserContext, options: ScreenshotOptions): Promise<Screenshot> {
    const timeout = options.timeout ?? 30_000
    const errors: string[] = []
    const failedRequests: FailedRequest[] = []
    const inflight = new Set<Request>()
    let lastActivity = Date.now()
    // Once per request: a response with an error status can still fail afterwards (Chromium aborts its body).
    const reported = new WeakSet<Request>()
    const failed = (request: Request, status: number | string): void => {
      if (reported.has(request))
        return
      reported.add(request)
      if ((status === 404 || status === 405) && isExpectedMiss({ path: new URL(request.url()).pathname }))
        return
      failedRequests.push({ method: request.method(), url: request.url(), status })
    }
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
      const error = request.failure()?.errorText ?? 'failed'
      if (error !== 'net::ERR_ABORTED')
        failed(request, error)
    })
    page.on('response', (response) => {
      if (response.status() >= 400)
        failed(response.request(), response.status())
    })

    const started = Date.now()
    await page.goto(pageUrl(options.url, options.path), { waitUntil: 'load', timeout })
    if (options.waitFor)
      await page.locator(options.waitFor).first().waitFor({ state: 'visible', timeout })
    const end = Date.now() + Math.min(SETTLE_MS, timeout)
    const quiet = async (): Promise<boolean> => {
      for (; Date.now() < end; await page.waitForTimeout(100)) {
        options.signal?.throwIfAborted()
        // Strings: tsconfig has no DOM types.
        if (inflight.size === 0 && Date.now() - lastActivity >= QUIET_MS && await page.evaluate<number>(SINCE_DOM_CHANGE) >= QUIET_MS)
          return true
      }
      return false
    }
    let settled = false
    while (!settled && await quiet()) {
      settled = await page.evaluate<number>(FINISH_ANIMATIONS) === 0
      // Let the end events run before the next check.
      if (!settled)
        await page.waitForTimeout(100)
    }
    // The capture waits for web fonts (`document.fonts.ready`) within the timeout.
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
