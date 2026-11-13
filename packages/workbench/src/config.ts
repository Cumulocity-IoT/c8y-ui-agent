// The parts of `.c8y-agent/config.yml` the workbench reads: corrections to what discovery detects. Other components
// read other keys (protect, playbooks, limits), so unknown top-level keys are left alone. See docs/discovery.md.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { WorkbenchError } from './target'

export const CONFIG_FILE = '.c8y-agent/config.yml'

const commands = z.record(z.string(), z.string().min(1))

const schema = z.object({
  world: z.strictObject({
    file: z.string().min(1).optional(),
    // Read by the workflow's prepare job, not here.
    pull: z.unknown().optional(),
  }).optional(),
  e2e: z.strictObject({
    root: z.string().min(1).optional(),
    config: z.string().min(1).optional(),
    auth: z.enum(['open', 'login']).optional(),
    env: z.record(z.string().regex(/^[A-Za-z_]\w*$/), z.string()).optional(),
  }).optional(),
  commands: commands.optional(),
  projects: z.record(z.string(), z.strictObject({ commands: commands.optional() })).optional(),
})

export type AgentConfig = z.infer<typeof schema>

/** `.c8y-agent/config.yml` of the repository, or undefined without one. Invalid content is an error, not ignored. */
export function readAgentConfig(repo: string): AgentConfig | undefined {
  const file = join(repo, CONFIG_FILE)
  if (!existsSync(file))
    return undefined
  let value: unknown
  try {
    value = parse(readFileSync(file, 'utf8')) ?? {}
  }
  catch (error) {
    throw new WorkbenchError(`${CONFIG_FILE} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`)
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success)
    throw new WorkbenchError(`${CONFIG_FILE}: ${parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`)
  return parsed.data
}
