// semantic-release: every push to `main` (dist-tag `latest`) or `next`
// (prereleases, dist-tag `next`) releases the packages under packages/
// (@cumulocity-iot/c8y-ui-workbench, @cumulocity-iot/c8y-ui-apply) to GitHub
// Packages, all with one version, when the conventional commits since the last
// tag call for it.
// The tag `v<version>` also versions the reusable workflow and the agent pack.
// See CONTRIBUTING.md.
const PACKAGES = './packages/*'

export default {
  branches: ['main', { name: 'next', prerelease: true }],
  tagFormat: 'v${version}',
  plugins: [
    ['@semantic-release/commit-analyzer', { preset: 'conventionalcommits' }],
    ['@semantic-release/release-notes-generator', { preset: 'conventionalcommits' }],
    // pnpm, not @semantic-release/npm: only `pnpm publish` resolves the `catalog:` specifiers.
    ['@semantic-release/exec', {
      prepareCmd: `pnpm -r --filter '${PACKAGES}' exec npm pkg set version=\${nextRelease.version}`,
      publishCmd: `pnpm -r --filter '${PACKAGES}' publish --no-git-checks --tag \${nextRelease.channel || 'latest'}`,
    }],
    // The GitHub release (with the notes) is the changelog; nothing is committed back.
    '@semantic-release/github',
  ],
}
