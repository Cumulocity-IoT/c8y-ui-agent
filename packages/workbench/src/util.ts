import { createServer } from 'node:net'

/** The last `size` lines of a process' output: what a failed build or run reports. */
export class LogTail {
  private readonly lines: string[] = []
  constructor(private readonly size = 200) {}

  readonly push = (line: string): void => {
    this.lines.push(line)
    if (this.lines.length > this.size)
      this.lines.shift()
  }

  tail(count = this.size): string[] {
    return this.lines.slice(-count)
  }
}

// Ports handed out in this process: two runs that start at once must not get the same one before either binds it.
const handedOut = new Set<number>()

/** A free TCP port on 127.0.0.1, not handed out before in this process. */
export async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer()
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as { port: number }
        server.close(() => resolve(port))
      })
    })
    if (!handedOut.has(port)) {
      handedOut.add(port)
      return port
    }
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
