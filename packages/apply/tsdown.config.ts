import { defineConfig } from 'tsdown'

// Bundled, with no runtime dependencies: the apply job installs only this package, and nothing it installs resolves
// a version range at install time. yaml is a devDependency, so tsdown inlines it.
export default defineConfig({
  entry: ['src/cli.ts', 'src/index.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  fixedExtension: true,
  dts: true,
  clean: true,
})
