import { describe, expect, it } from 'vitest'
import { version } from '../src/index'

describe('workbench', () => {
  it('exports its version', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+/)
  })
})
