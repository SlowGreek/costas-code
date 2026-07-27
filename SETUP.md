# Catalyst — Setup for the Team

Everything needed to get Catalyst running on a Mac, in order, with nothing
generic in the way. If a step fails, the fix is listed directly under it.

Catalyst is a downstream fork of [Hermes Agent](https://github.com/NousResearch/hermes-agent).
The public README covers Hermes at large; **this file is the path we actually use.**

---

## The one thing that trips everyone up

Catalyst has **two separate logins**, and they are not interchangeable:

| | What it's for | How |
| --- | --- | --- |
| **GitHub** (`gh auth login`) | Downloading Catalyst — the repo is private | GitHub CLI |
| **Copilot** (device code) | Talking to the model | `hermes model` → Copilot → device code |

`gh auth login` does **not** get you Copilot access. Its token is a `gho_`/`ghp_`
token scoped to the GitHub API; the Copilot endpoint rejects it. Copilot needs a
`ghu_` token that only the device-code flow issues.

If you hit `403 Access to this endpoint is forbidden`, you are almost certainly
using a `gh` token where a Copilot token belongs. Jump to
[Copilot 403](#copilot-403-access-to-this-endpoint-is-forbidden).

---

## 1. Prerequisites

```bash
# GitHub CLI — required, the repo is private
brew install gh
gh auth login          # pick HTTPS when asked

# Verify you can actually see the repo
gh repo view SlowGreek/costas-code --json name
```

That last command must print the repo name. A 404 means your account has not
accepted the invite yet — check your email or
[github.com/notifications](https://github.com/notifications).

Also needed: **Python 3.11–3.13** and **Node.js 20.19+** (22.12+ preferred).
The installer brings its own if you don't have them.

---

## 2. Install

### Option A — the desktop app (recommended)

Download the newest `.dmg` from
[Releases](https://github.com/SlowGreek/costas-code/releases), drag
**Catalyst.app** to Applications, then launch it.

Builds are unsigned, so the first launch needs **Control-click → Open** rather
than a double-click.

On first launch the app bootstraps itself: it downloads the install script using
your `gh` credentials and builds a managed checkout at `~/.hermes/hermes-agent`.
That checkout provides the `hermes` CLI the app runs as its backend. It takes a
few minutes once.

### Option B — from source

```bash
gh repo clone SlowGreek/costas-code
cd costas-code
bash scripts/install.sh --dir "$PWD" --skip-setup
npm install
```

---

## 3. Connect Copilot

```bash
hermes model
```

Choose **Copilot**, then **device code login**. A browser opens; paste the code
it shows you. This issues the `ghu_` token Copilot actually accepts and saves it
as `COPILOT_GITHUB_TOKEN`.

Confirm it worked:

```bash
hermes model        # should show Copilot as the active provider
hermes              # start a conversation
```

---

## Troubleshooting

### Copilot: 403 "Access to this endpoint is forbidden"

**Cause:** a GitHub token is being used where a Copilot token is required.
`gh auth token` returns `gho_`/`ghp_`; Copilot needs `ghu_` from the device-code
flow. Only the approved Copilot clients are entitled by your subscription, and
the token type is how GitHub tells them apart.

**Fix:**

```bash
hermes model        # Copilot → device code login
```

Check which token is in play:

```bash
grep COPILOT_GITHUB_TOKEN ~/.hermes/.env    # want: ghu_...
```

If it starts with `gho_` or `ghp_`, that's the problem — rerun the device-code
login. Note that `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, and `GITHUB_TOKEN` are read
in that order, so a stray `GH_TOKEN` in your shell can shadow a good token:

```bash
env | grep -E "GH_TOKEN|GITHUB_TOKEN"
```

**Not a workaround:** do not hand-edit headers or client identifiers to get past
the 403. That circumvents GitHub's access controls and risks your Copilot
subscription. The device-code flow is the supported path and it works.

### Install fails with HTTP 404

The repo is private, so anonymous downloads are refused — GitHub returns 404
rather than revealing that the repo exists. This is an access response, not a
missing file.

```bash
gh auth status                                   # must be logged in
gh repo view SlowGreek/costas-code --json name   # must succeed
```

Builds older than `be31aea55` cannot use `gh` credentials at all. If yours is
older, download a current release.

### Which build am I running?

```bash
cat "/Applications/Catalyst.app/Contents/Resources/install-stamp.json"
git -C ~/.hermes/hermes-agent log --oneline -1
```

Versions look like `0.17.0-ci.11+sha.0f6ca05b` — `ci.11` is the build number and
`sha.` is the commit. Two different builds always differ here.

The app and its backend update independently and can drift; the app says so when
they do.

### The app launches but nothing responds

The backend probably failed to bootstrap.

```bash
hermes doctor
tail -50 ~/.hermes/logs/errors.log
```

### Starting clean

```bash
rm -rf ~/.hermes/hermes-agent    # backend checkout; keeps config and sessions
```

Your settings, sessions, and skills live elsewhere under `~/.hermes` and survive
this.

---

## Getting help

`/feedback <what went wrong>` inside Catalyst files a GitHub issue with your
version, platform, model, and recent errors attached. Nothing from the
conversation is included.
