#!/usr/bin/env node
// PreToolUse guard of the C8Y UI Agent: denies some tool calls that the apply job would reject or that cannot work on
// the agent's runner, so the agent learns it at once instead of losing the run (the list: docs/pack.md). It prevents mistakes; it is not a security
// boundary: the agent can reach the same effects another way, and the apply job checks every result (D2, docs/pack.md).
// Plain Node, no dependencies: Claude Code runs it from the plugin directory.
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

// Commands that run the command after their own options; per wrapper, the options that take a value, and whether
// one plain argument comes before the command (timeout's duration).
const WRAPPERS = {
  sudo: { values: ['-u', '-g', '-C', '-h', '-p'] },
  env: { values: ['-u', '-C', '-S'] },
  exec: { values: ['-a'] },
  nice: { values: ['-n'] },
  nohup: { values: [] },
  time: { values: ['-f', '-o'] },
  timeout: { values: ['-s', '-k', '--signal', '--kill-after'], argument: true },
  xargs: { values: ['-I', '-i', '-n', '-P', '-L', '-l', '-d', '-E', '-e', '-s', '-a'] },
  command: { values: [] },
}
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])
const REMOTE_CHANGES = new Set(['add', 'set-url', 'rename', 'remove', 'rm', 'set-branches'])
const ADD_EVERYTHING = new Set(['.', './', ':/', ':(top)', '*', '--all', '--no-ignore-removal'])
// Agent instructions are protected at any depth, as in the apply job's check (packages/apply/src/paths.ts).
const PROTECTED_ANY_DEPTH = new Set(['.claude', 'agents.md', 'claude.md', 'claude.local.md', '.mcp.json'])
const PROTECTED_AT_ROOT = new Set(['.github', '.c8y-agent'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/**
 * The simple commands of a shell command line, as word lists: split at `;`, `&`, `&&`, `|`, `||`, newlines, `(`, `)`,
 * backticks, and `$(` outside quotes. Quoted text stays in its word, and here-documents are skipped, so a commit
 * message that mentions `git push` is not a command.
 */
function commands(line) {
  const result = []
  let words = []
  let word = ''
  let quoted = false
  let quote = null
  let heredocs = []
  const endWord = () => {
    if (word !== '' || quoted)
      words.push(word)
    word = ''
    quoted = false
  }
  const endCommand = () => {
    endWord()
    if (words.length > 0)
      result.push(words)
    words = []
  }
  let i = 0
  while (i < line.length) {
    const c = line[i]
    if (quote) {
      if (c === quote)
        quote = null
      else if (c === '\\' && quote === '"' && i + 1 < line.length)
        word += line[++i]
      else
        word += c
      i++
      continue
    }
    if (c === '\'' || c === '"') {
      quote = c
      quoted = true
      i++
      continue
    }
    if (c === '\\') {
      if (line[i + 1] !== '\n')
        word += line[i + 1] ?? ''
      i += 2
      continue
    }
    if (c === '<' && line[i + 1] === '<' && line[i + 2] !== '<') {
      const heredoc = /^<<(-?)[ \t]*(['"]?)([\w.-]+)\2/.exec(line.slice(i))
      if (heredoc) {
        heredocs.push({ end: heredoc[3], tabs: heredoc[1] === '-' })
        endWord()
        i += heredoc[0].length
        continue
      }
    }
    if (c === '\n') {
      endCommand()
      i++
      for (const { end, tabs } of heredocs) {
        while (i < line.length) {
          const next = line.indexOf('\n', i)
          const text = line.slice(i, next < 0 ? line.length : next)
          i = next < 0 ? line.length : next + 1
          if ((tabs ? text.replace(/^\t+/, '') : text) === end)
            break
        }
      }
      heredocs = []
      continue
    }
    if (';&|()`'.includes(c)) {
      endCommand()
      i++
      continue
    }
    if (c === '$' && line[i + 1] === '(') {
      endCommand()
      i += 2
      continue
    }
    if (/\s/.test(c)) {
      endWord()
      i++
      continue
    }
    word += c
    i++
  }
  endCommand()
  return result
}

/** The program and its arguments, after variable assignments and wrappers such as `env`, `sudo`, or `timeout`. */
function program(words) {
  let i = 0
  while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i]))
    i++
  while (i < words.length && Object.hasOwn(WRAPPERS, words[i])) {
    const wrapper = WRAPPERS[words[i]]
    if (words[i] === 'command' && /^-[vV]$/.test(words[i + 1] ?? ''))
      return { name: undefined, args: [] } // command -v gh: looks a program up, runs nothing
    i++
    while (i < words.length && (words[i].startsWith('-') || /^[A-Za-z_]\w*=/.test(words[i])))
      i += wrapper.values.includes(words[i]) ? 2 : 1
    if (wrapper.argument)
      i++
  }
  return { name: words[i]?.split('/').pop(), args: words.slice(i + 1) }
}

/** The git subcommand and its arguments, after git's global options. */
function gitCommand(args) {
  let i = 0
  while (i < args.length && args[i].startsWith('-'))
    i += GIT_OPTIONS_WITH_VALUE.has(args[i]) ? 2 : 1
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
    if ((sub === 'remote' && REMOTE_CHANGES.has(rest[0]))
      || (sub === 'config' && rest.some(arg => /^(?:remote\.|url\.)/i.test(arg)) && !rest.some(arg => /^(?:--get|--get-all|--get-regexp|-l|--list)$/.test(arg))))
      return 'The agent does not change git remotes.'
    if (sub === 'pull' || sub === 'merge')
      return 'The apply job rejects merge commits, and the run works on its base commit only. Do not pull or merge.'
    if ((sub === 'add' || sub === 'stage') && rest.some(arg => ADD_EVERYTHING.has(arg) || /^-[a-zA-Z]*A[a-zA-Z]*$/.test(arg)))
      return 'Stage the files of the change by name (git add <file>…). Builds and previews leave output in the checkout that must not be committed.'
  }
  return undefined
}

function editReason(file, cwd, root) {
  if (typeof file !== 'string' || file === '')
    return undefined
  const path = relative(root, resolve(cwd, file))
  if (path === '' || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path))
    return undefined
  const parts = path.split(sep).map(part => part.toLowerCase())
  if (PROTECTED_AT_ROOT.has(parts[0]) || parts.some(part => PROTECTED_ANY_DEPTH.has(part)))
    return `${path} is protected: the apply job rejects a result that changes it. Agent configuration, instructions, and .github/ are changed by people.`
  return undefined
}

/**
 * The guard's decision for one PreToolUse event (Claude Code's hook input): a reason to deny, or undefined to let
 * the normal permission rules decide. `root` is the checkout (Claude Code's project directory); protected paths are
 * relative to it, whatever directory the agent is in.
 */
export function decide(event, root = event?.cwd ?? process.cwd()) {
  const input = event?.tool_input ?? {}
  if (event?.tool_name === 'Bash' && typeof input.command === 'string')
    return bashReason(input.command)
  if (EDIT_TOOLS.has(event?.tool_name))
    return editReason(input.file_path ?? input.notebook_path, event.cwd ?? root, root)
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
  const reason = decide(event, process.env.CLAUDE_PROJECT_DIR || event?.cwd || process.cwd())
  if (reason)
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  await main()
