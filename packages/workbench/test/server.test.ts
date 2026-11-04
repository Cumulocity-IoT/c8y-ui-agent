import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from '../src/server'

describe('MCP server', () => {
  let repo: string
  let client: Client
  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'workbench-server-'))
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'single-app' }))
    const { server } = createServer({ repo, world: 'mock/world.json' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    client = new Client({ name: 'test', version: '0' })
    await client.connect(clientTransport)
  })
  afterAll(async () => {
    await client.close()
    rmSync(repo, { recursive: true, force: true })
  })

  it('lists the tools', async () => {
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name).sort()).toEqual(['list_apps', 'preview_down', 'preview_log', 'preview_up', 'prove_regression'])
    expect(tools.find(t => t.name === 'prove_regression')?.inputSchema.required).toEqual(['app'])
  })

  it('lists the apps', async () => {
    const result = await client.callTool({ name: 'list_apps', arguments: {} })
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toEqual([{ name: repo.split('/').pop(), dir: '' }])
  })

  it('reports errors as tool errors', async () => {
    const log = await client.callTool({ name: 'preview_log', arguments: { id: 'preview-9' } })
    expect(log.isError).toBe(true)
    expect((log.content as Array<{ text: string }>)[0]!.text).toBe('no preview preview-9; running: none')
    const preview = await client.callTool({ name: 'preview_up', arguments: { app: 'missing' } })
    expect(preview.isError).toBe(true)
    expect((preview.content as Array<{ text: string }>)[0]!.text).toContain('no app missing')
  })
})
