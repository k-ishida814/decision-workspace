# Decision Workspace

Answer Claude Code's questions one at a time, in a workspace of their own.

When Claude Code asks you something (`AskUserQuestion`), the question goes to a queue in a
terminal UI (`dw tui`) instead of interrupting the chat. You answer there, one decision at a
time, with a reason if you like. Only the decision and its reason go back to Claude, so long
discussions do not fill its context.

On top of the queue:

- **Decision graph**: decisions can depend on each other ("sync method" only matters if
  "storage" is "cloud"). Changing an answer reopens what depends on it.
- **Deep Dive**: an agent researches one decision's options and recommends one.
- **Planner**: describe what you want to build; an agent lists the decisions you need to make,
  with their dependencies.
- **Reviewer**: an agent checks your answers for conflicts and missing decisions. It only
  proposes; you accept or dismiss.
- **Back to Claude**: decisions made in the workspace are added to your next prompt, and Claude
  can queue decisions without waiting for you (MCP).

Status: early (0.x). macOS on Apple Silicon. Data stays on your machine.

## Requirements

- macOS on Apple Silicon
- [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude` on your PATH). The
  agents (Deep Dive, Planner, Reviewer) run through your own `claude` and use your plan's usage.

## Install

```sh
brew install k-ishida814/tap/decision-workspace
```

Or download `dw-<version>-darwin-arm64.tar.gz` from the releases page and put `dw` on your PATH.

## Quick start

```sh
cd your-project
dw install      # adds the hook and the MCP server to this project's Claude Code settings
dw tui          # keep this open; questions arrive here
```

Restart Claude Code in the project. When it asks a question, answer it in `dw tui`. If no
`dw tui` is open, Claude Code asks in its own UI as usual. Press `t` in the TUI to hand a
question back to Claude Code.

`dw uninstall` removes exactly what `dw install` added.

## The TUI

| Key            | What it does                                                |
| -------------- | ----------------------------------------------------------- |
| `1`-`9`, Enter | choose an option and confirm                                |
| `o` / `w`      | answer in your own words / write why                        |
| `s` / `h`      | skip / put aside                                            |
| `d`            | Deep Dive on this decision (calls the model)                |
| `p`            | Planner: list the decisions for a request (calls the model) |
| `r`            | Reviewer: check the decided answers (calls the model)       |
| `a` / `x`      | accept / dismiss a Reviewer proposal (History)              |
| `u`            | change a decided answer (History / Graph)                   |
| Tab            | Current / Queue / History / Graph                           |
| `?`            | all keys                                                    |

## Commands

```text
dw tui                         answer decisions one at a time
dw list | show <id> | diff <id>
dw add <question> [-o <option>]... [--after <id>[=<option>]]
dw answer <id> <choice> [-w <why>]    dw skip|cancel|revisit|hold <id>
dw plan "<request>"            Planner
dw explore <id>                Deep Dive
dw review [--plan P-n]         Reviewer;  dw proposals, dw accept|dismiss RV-n
dw graph [--format mermaid]    every decision with dependencies and answers
dw stats                       agent runs and cost, context handed to Claude
dw config get|set <key> <value>   agents.model, agents.maxBudgetUsd, agents.maxTurns, agents.concurrency
dw install|uninstall [--local]
```

Add `--json` for machine-readable output. `dw --help` lists everything.

## How it works

- A small daemon keeps each project's decisions in SQLite at
  `<project>/.decision-workspace/decisions.db` and talks to the TUI, the CLI, the hook and the
  MCP server over a Unix socket (`~/.decision-workspace/daemon.sock`, owner only). It starts on
  demand.
- `dw install` registers `dw hook` for `PreToolUse(AskUserQuestion)` and `UserPromptSubmit`, and
  `dw mcp` in `.mcp.json`. The hook fails open: if anything goes wrong, Claude Code carries on
  as if it were not there.
- Agents run as `claude -p` with read-only tools (Read, Grep, Glob, WebSearch, WebFetch), a
  budget and turn limit (`dw config`), and hooks disabled. They only run when you start them.
  Transcripts stay in `.decision-workspace/runs/`.

Add `.decision-workspace/` to your project's `.gitignore` unless you want to commit decisions.

## Development

```sh
bun install
bun run check          # lint, type check, tests
bun run dw -- <args>   # dw from source
bun run build          # single binary in dist/dw
```

Design documents (in Japanese): [requirements](docs/requirements.md),
[tech stack](docs/tech-stack.md), [tasks](docs/tasks.md), [ADRs](docs/adr/),
[development guide](docs/development.md).

## Contributing

Issues (bug reports, ideas) are welcome; pull requests are not accepted. See
[CONTRIBUTING.md](CONTRIBUTING.md) and, for vulnerabilities, [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
