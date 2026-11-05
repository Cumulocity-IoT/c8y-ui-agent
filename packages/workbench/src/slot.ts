// One e2e run at a time per workbench, check or proof: two proofs would share the checkout's .git/worktrees, and
// parallel Cypress runs compete for CPU, which makes tests flaky.
import { WorkbenchError } from './target'

export class Slot {
  private current?: { tool: string, abort: AbortController, done: Promise<unknown> }

  /** Runs `work`, unless another run holds the slot: then it rejects at once. The slot is free again when `work` ends. */
  async run<T>(tool: string, signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.current)
      throw new WorkbenchError(`${this.current.tool} is already running; wait for its result`)
    const abort = new AbortController()
    const running = work(signal ? AbortSignal.any([signal, abort.signal]) : abort.signal)
    const current = { tool, abort, done: running.catch(() => {}) }
    this.current = current
    try {
      return await running
    }
    finally {
      if (this.current === current)
        this.current = undefined
    }
  }

  /** Aborts the running work, runs `cleanup`, and waits for the work to end, at most `wait` ms. */
  async stop(reason: Error, cleanup: () => Promise<void> = async () => {}, wait = 1500): Promise<void> {
    const current = this.current
    if (!current)
      return
    current.abort.abort(reason)
    await cleanup()
    await Promise.race([current.done, new Promise(r => setTimeout(r, wait))])
  }
}
