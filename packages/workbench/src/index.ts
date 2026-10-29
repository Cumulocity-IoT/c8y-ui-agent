import { createRequire } from 'node:module'

// Read at runtime: semantic-release sets the version after the build.
const pkg = createRequire(import.meta.url)('../package.json') as { version: string }

/** The workbench version, as published. */
export const version: string = pkg.version
