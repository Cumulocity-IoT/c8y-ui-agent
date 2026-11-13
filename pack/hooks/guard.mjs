#!/usr/bin/env node
// PreToolUse guard of the C8Y UI Agent: denies tool calls that the apply job would reject or that cannot work on the
// agent's runner, so the agent learns it at once instead of losing the run. It prevents mistakes; it is not a security
// boundary: the agent can reach the same effects another way, and the apply job checks every result (D2, docs/pack.md).
// Plain Node, no dependencies: Claude Code runs it from the plugin directory.
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const WRAPPERS = new Set(['sudo', 'command', 'exec', 'env', 'time', 'nohup', 'nice', 'xargs'])
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])
const REMOTE_CHANGES = new Set(['add', 'set-url', 'rename', 'remove', 'rm', 'set-branches'])
const ADD_EVERYTHING = new Set(['.', './', ':/', ':(top)', '*', '--all', '--no-ignore-removal'])
// Agent instructions are protected at any depth, as in the apply job's check (packages/apply/src/paths.ts).
const PROTECTED_ANY_DEPTH = new Set(['.claude', 'agents.md', 'claude.md', 'claude.local.md', '.mcp.json'])
const PROTECTED_AT_ROOT = new Set(['.github', '.c8y-agent'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** Shell words of one command line, split into simple commands at `;`, `&&`, `||`, `|`, newlines, and subshells. */
function commands(line) {
  return line
    .split(/\|\||&&|[;|\n`()]|\$\(/)
    .map(part => part.trim().split(/\s+/).map(word => word.replace(/^['"]|['"]$/g, '')).filter(Boolean))
    .filter(words => words.length > 0)
}

/** The program and its arguments, without leading variable assignments and wrappers such as `env` or `sudo`. */
function program(words) {
  let i = 0
  while (i < words.length && (/^[A-Za-z_]\w*=/.test(words[i]) || WRAPPERS.has(words[i]) || (i > 0 && WRAPPERS.has(words[i - 1]) && words[i].startsWith('-'))))
    i++
  const name = words[i]?.split('/').pop()
  return { name, args: words.slice(i + 1) }
}

/** The git subcommand and its arguments, after git's global options. */
function gitCommand(args) {
  let i = 0
  while (i < args.length && args[i].startsWith('-')) {
    i += GIT_OPTIONS_WITH_VALUE.has(args[i]) ? 2 : 1
  }
  return { sub: args[i], rest: args.slice(i + 1) }
}

function bashReason(line) {
  for (const words of commands(line)) {
    const { name, args } = program(words)
    if (name === 'gh')
      return 'The agent has no GitHub access. Put what you want to say on GitHub in result.json; the apply job writes it.'
    if (name !== 'git')
      continue
    const { sub, rest } = gitCommand(args)
    if (sub === 'push')
      return 'The agent does not push. Commit locally; the apply job checks the commits and pushes them.'
    if (sub === 'remote' && REMOTE_CHANGES.has(rest[0]))
      return 'The agent does not change git remotes.'
    if (sub === 'pull' || sub === 'merge')
      return 'The apply job rejects merge commits, and the run works on its base commit only. Do not pull or merge.'
    if (sub === 'add' && rest.some(arg => ADD_EVERYTHING.has(arg) || /^-[a-zA-Z]*A[a-zA-Z]*$/.test(arg)))
      return 'Stage the files of the change by name (git add <file>…). Builds and previews leave output in the checkout that must not be committed.'
  }
  return undefined
}

function editReason(file, cwd) {
  if (typeof file !== 'string' || file === '')
    return undefined
  const path = relative(cwd, resolve(cwd, file))
  if (path === '' || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path))
    return undefined
  const parts = path.split(sep).map(part => part.toLowerCase())
  if (PROTECTED_AT_ROOT.has(parts[0]) || parts.some(part => PROTECTED_ANY_DEPTH.has(part)))
    return `${path} is protected: the apply job rejects a result that changes it. Agent configuration, instructions, and .github/ are changed by people.`
  return undefined
}

/**
 * The guard's decision for one PreToolUse event (Claude Code's hook input): a reason to deny, or undefined to let
 * the normal permission rules decide.
 */
export function decide(event) {
  const input = event?.tool_input ?? {}
  if (event?.tool_name === 'Bash' && typeof input.command === 'string')
    return bashReason(input.command)
  if (EDIT_TOOLS.has(event?.tool_name))
    return editReason(input.file_path ?? input.notebook_path, event.cwd ?? process.cwd())
  return undefined
}

async function main() {
  let source = ''
  for await (const chunk of process.stdin)
    source += chunk
  let event
  try {
    event = JSON.parse(source)
  }
  catch {
    return // Not a hook event: leave the decision to the permission rules.
  }
  const reason = decide(event)
  if (reason)
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  await main()
