import { describe, expect, it } from 'vitest'
import { Slot } from '../src/slot'

/** Work that runs until aborted, then rejects with the abort reason. */
const untilAborted = (signal: AbortSignal): Promise<never> => new Promise((_, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true })
})

describe('Slot', () => {
  it('refuses a second run while one runs, and frees the slot when it ends', async () => {
    const slot = new Slot()
    let finish = (): void => {}
    const first = slot.run('check', undefined, () => new Promise<string>((resolve) => {
      finish = () => resolve('done')
    }))
    await expect(slot.run('prove_regression', undefined, async () => 'second')).rejects.toThrow('check is already running; wait for its result')
    finish()
    await expect(first).resolves.toBe('done')
    await expect(slot.run('prove_regression', undefined, async () => 'next')).resolves.toBe('next')
  })

  it('frees the slot after a failed run', async () => {
    const slot = new Slot()
    await expect(slot.run('check', undefined, async () => {
      throw new Error('spec x is not a file')
    })).rejects.toThrow('spec x is not a file')
    await expect(slot.run('check', undefined, async () => 'ok')).resolves.toBe('ok')
  })

  it('passes the caller\'s abort on to the work', async () => {
    const slot = new Slot()
    const abort = new AbortController()
    const running = slot.run('check', abort.signal, untilAborted)
    abort.abort(new Error('cancelled'))
    await expect(running).rejects.toThrow('cancelled')
  })

  it('stops the running work, runs the cleanup, and waits for the work to end', async () => {
    const slot = new Slot()
    const order: string[] = []
    const running = slot.run('check', undefined, signal => untilAborted(signal).finally(() => order.push('work ended')))
    running.catch(() => {})
    await slot.stop(new Error('the workbench stops'), async () => {
      order.push('cleanup')
    })
    await expect(running).rejects.toThrow('the workbench stops')
    expect(order).toEqual(['cleanup', 'work ended'])
    await slot.stop(new Error('nothing runs'))
  })

  it('waits at most the given time for work that does not end', async () => {
    const slot = new Slot()
    void slot.run('check', undefined, () => new Promise(() => {}))
    const started = Date.now()
    await slot.stop(new Error('stop'), undefined, 50)
    expect(Date.now() - started).toBeLessThan(1000)
  })
})
