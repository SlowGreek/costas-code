---
name: copilot-cli
description: Delegate coding tasks to GitHub Copilot CLI.
version: 1.0.0
author: SlowGreek, Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Coding-Agent, GitHub, Copilot, Code-Review, Refactoring]
    related_skills: [claude-code, codex, hermes-agent, opencode]
---

# GitHub Copilot CLI Skill

Delegate repository work to GitHub Copilot CLI through Hermes' `terminal` and
`process` tools. The bundled runner keeps command construction cross-platform,
uses noninteractive prompt mode, and preserves normal path and URL boundaries.

## When to Use

- Implementing a feature or bug fix in an isolated worktree
- Running a focused refactor with a named, resumable Copilot session
- Reviewing a branch or pull request from a disposable checkout
- Parallelizing independent coding tasks across separate worktrees

Use Hermes' own `read_file`, `search_files`, and `patch` tools for small edits
that do not benefit from a separate coding-agent context.

## Prerequisites

- Install GitHub Copilot CLI from the official package:

  ```text
  npm install -g @github/copilot
  ```

- Authenticate once with `copilot login`, or provide a supported
  `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN`.
- If Copilot has no saved login, the runner promotes a supported `GH_TOKEN` or
  `GITHUB_TOKEN` to `COPILOT_GITHUB_TOKEN` for the child process. It also checks
  `gh auth token` without writing the credential to disk.
- Confirm the target directory is trusted and inspect its current Git status.
- Keep each parallel writer in a different Git worktree.

Verify availability through `terminal`:

```text
copilot --version
```

If the executable is installed outside `PATH`, set `COPILOT_CLI_PATH` to its
absolute path or pass `--command` to the runner.

## How to Run

Run the helper with `terminal`, replacing `SKILL_DIR` with this skill's
resolved directory:

```text
python3 SKILL_DIR/scripts/copilot_delegate.py \
  --workdir /absolute/path/to/repo \
  --prompt "Fix the failing authentication test and run the targeted suite."
```

The runner enables noninteractive tool execution with
`--allow-all-tools`, but deliberately does not grant `--allow-all-paths`,
`--allow-all-urls`, or `--yolo`.

For long tasks, start the same command with `background=true` and
`notify_on_complete=true`, then inspect it with `process`.

## Quick Reference

| Goal | Runner option |
| --- | --- |
| Choose a model | `--model gpt-5.4` |
| Name a new thread | `--name auth-fix` |
| Continue a thread | `--resume auth-fix` |
| Emit JSONL events | `--output-format json` |
| Use autopilot | `--autopilot --max-autopilot-continues 8` |
| Cap AI credits | `--max-ai-credits 30` (minimum accepted value) |
| Disable GitHub MCP | `--disable-github-mcp` |
| Override executable | `--command /absolute/path/to/copilot` |
| Read prompt from file | `--prompt-file /absolute/path/to/prompt.txt` |

Hermes can also use Copilot as its primary inference provider without spawning
the CLI:

```text
hermes chat --provider copilot --model gpt-5.4
```

To route complete Hermes turns through the local Copilot ACP process instead:

```text
hermes chat --provider copilot-acp --model copilot-acp
```

## Procedure

### 1. Inspect and isolate

Use `terminal` to inspect `git status`. For a writing task, create a dedicated
branch and worktree:

```text
git worktree add -b agent/auth-fix .worktrees/auth-fix main
```

Do not launch two writing agents in the same checkout.

### 2. Start a named coding thread

```text
python3 SKILL_DIR/scripts/copilot_delegate.py \
  --workdir /absolute/path/to/repo/.worktrees/auth-fix \
  --name auth-fix \
  --model gpt-5.4 \
  --prompt "Fix the authentication regression. Add a focused test, run it, and summarize the diff."
```

The session name makes later continuation explicit:

```text
python3 SKILL_DIR/scripts/copilot_delegate.py \
  --workdir /absolute/path/to/repo/.worktrees/auth-fix \
  --resume auth-fix \
  --prompt "Address the remaining test failure and rerun the targeted suite."
```

### 3. Run independent threads in parallel

Create one worktree per task, then invoke the runner once per worktree with
`background=true`. Use `process(action="list")`, `process(action="poll")`, and
`process(action="log")` to monitor them without injecting repeated prompts.

### 4. Review before integrating

After Copilot exits:

1. Use `terminal` to inspect `git status` and `git diff`.
2. Use `read_file` for every security-sensitive or behavior-critical change.
3. Run the smallest targeted test that covers the task.
4. Commit, push, or merge only after the worktree is verified.
5. Remove the worktree only after preserving or intentionally discarding its
   changes.

## Pitfalls

1. **`--allow-all-tools` is still powerful.** It auto-approves tools available
   to Copilot. Use only trusted repositories and isolated worktrees.
2. **Do not replace it with `--allow-all` or `--yolo`.** Those also remove path
   and URL boundaries.
3. **A session is not a worktree.** Resume a named session in the same worktree
   unless you intentionally want it to operate on a different checkout.
4. **Subprocess completion is not verification.** Always inspect the diff and
   run the relevant tests yourself.
5. **Avoid shared writers.** Parallel agents editing one checkout can overwrite
   each other even when their conversation contexts are separate.
6. **Keep prompts self-contained.** Copilot receives repository instructions,
   but not Hermes' full conversation unless the prompt includes the relevant
   constraints.
7. **JSON output is JSONL.** Parse it one object per line rather than as one
   JSON document.
8. **Remote export is disabled by the runner.** Remove that protection only
   when the user explicitly requests sharing the session.
9. **Classic PATs are not Copilot credentials.** The runner ignores `ghp_*`
   values; use Copilot OAuth or a fine-grained PAT with Copilot Requests.

## Verification

Before reporting success:

1. Confirm the runner exited with status zero.
2. Confirm the work happened in the intended worktree and branch.
3. Inspect the complete diff for unrelated changes.
4. Run the targeted formatter, type check, build, or test already used by the
   repository.
5. Confirm no secrets, generated credentials, or session exports were added.
6. Report the Copilot session name and worktree path when follow-up work may be
   needed.
