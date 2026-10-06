# youtrack-onprem-mcp

A minimal MCP server for **on-premises YouTrack**. Fourteen tools, no build step, no
Docker.

## Why this exists

YouTrack ships its own MCP server as of **2025.3**. On YouTrack Cloud that is the whole
story — JetBrains upgrades those instances themselves, so every Cloud instance already
has it. Use it there; this project has nothing to add.

Self-hosted YouTrack Server is different. It upgrades on the administrator's schedule,
not JetBrains', and plenty of installs sit years behind — with no MCP option at all. That
gap is what this fills, and it is the only case it is built for.

It stays useful after an upgrade for anyone who wants a low-context alternative: it is
built around spending as few tokens as possible per answer, and the tool count is kept
small on purpose. Every tool schema is resident in context for the whole session, whether
or not it is ever called, so every tool has to earn its place.

## Compatibility

Everything here speaks YouTrack's modern `/api` REST API, which YouTrack Server has
served since **2018.1**. Nothing version-gated is used: no field selector, endpoint, or
query form below that arrived after that release.

| YouTrack Server | Status |
| --- | --- |
| 2018.1 – 2025.2 | **What this is for.** Verified against 2025.1 |
| 2025.3 and newer | Works, but prefer the [built-in MCP server][builtin] |
| Older than 2018.1 | Not supported — predates the `/api` REST API |

Check what you are on:

```sh
curl -H "Authorization: Bearer <token>" "$YOUTRACK_URL/api/config?fields=version,build"
```

### Deployment shapes

Self-hosted installs vary in ways a Cloud instance never does, so all of these are
handled:

| Your instance | `YOUTRACK_URL` |
| --- | --- |
| Own subdomain | `https://youtrack.example.com` |
| Under a context path | `https://example.com/youtrack` |
| Nested deeper | `https://intranet.example.com/tools/youtrack` |
| Non-standard port | `https://youtrack.example.com:8443` |
| Plain HTTP on an internal network | `http://youtrack.internal:8080` |

The port is part of the identity check, so a token scoped to `:8443` is never sent to
`:443` on the same host. Give the scheme explicitly for an HTTP-only instance — a bare
hostname is assumed to be `https://`.

`http://` is accepted rather than blocked, because plenty of internal installs are served
that way and refusing them would only push people toward disabling verification
elsewhere. Know what it costs: the bearer token crosses the network in cleartext, so it is
a reasonable choice on a trusted segment and a poor one over anything wider.

Attachment URLs are the reason the context path matters: YouTrack hands those back in its
own payload, and whether they already carry the prefix is not guaranteed. Both forms
resolve to the same URL, so the prefix is never doubled.

[builtin]: https://www.jetbrains.com/help/youtrack/server/model-context-protocol-server.html

## Requirements

Node **24+** — `src/*.ts` runs directly via native type stripping, so there is no compile
step and no `dist/`. Only [erasable TypeScript syntax][erasable] is allowed (no `enum`,
no parameter properties, no decorators).

Debian and Ubuntu archives ship Node 18/20, so install from NodeSource:

```sh
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v          # must print v24.x or newer
```

On macOS, `brew install node` or any version manager works.

[erasable]: https://nodejs.org/api/typescript.html#type-stripping

## Install

```sh
git clone https://github.com/paulem/youtrack-onprem-mcp.git ~/youtrack-onprem-mcp
cd ~/youtrack-onprem-mcp
git checkout "$(git describe --tags --abbrev=0)"   # latest release, not main
npm ci                             # two runtime deps, no build step
chmod +x bin/youtrack-onprem-mcp   # in case the mode bit did not survive the copy
```

Releases are git tags (`v3.0.0`, …). `main` may carry unreleased work, so stay on a tag.

## Configuration

Nothing instance-specific is committed. `bin/youtrack-onprem-mcp` reads it all at launch
from `~/.config/youtrack-onprem-mcp/`, which the repo never touches.

### 1. Point it at your instance

```sh
mkdir -p ~/.config/youtrack-onprem-mcp
cat > ~/.config/youtrack-onprem-mcp/config <<'EOF'
YOUTRACK_URL=https://youtrack.example.com
EOF
chmod 600 ~/.config/youtrack-onprem-mcp/config
```

The file is a shell fragment of `KEY=value` lines, sourced by the wrapper — so a value
can be computed if you need it to be. It runs as you, so keep it `0600` and yours.
`YOUTRACK_MCP_CONFIG` points somewhere else if you prefer, and any variable already
exported in the environment wins over the file.

Include the context path and port if your instance has them — see *Deployment shapes*
above. A trailing slash is trimmed and a bare hostname is assumed to be `https://`, so
all four of these mean the same thing:

```
https://youtrack.example.com     https://youtrack.example.com/
youtrack.example.com             YOUTRACK.EXAMPLE.COM
```

### 2. Provide the token

Create a permanent token in *Profile → Account Security → Tokens*. The wrapper tries four
sources in order and uses the first that answers, so the same wrapper works on a laptop
and on a headless box:

| Order | Source | Use on |
| --- | --- | --- |
| 1 | `$YOUTRACK_API_TOKEN` already exported | systemd units, CI |
| 2 | macOS Keychain | macOS |
| 3 | `secret-tool` (libsecret) | Linux desktop with an unlocked keyring |
| 4 | `0600` token file | **headless Linux** |

On macOS:

```sh
security add-generic-password -U -A -s youtrack-onprem-mcp -a "$(id -un)" -w '<token>'
```

**`-A` is not optional, and it must be repeated on every rotation.** Without it macOS
raises a GUI authorization prompt (*"security wants to access key
youtrack-onprem-mcp"*) on every read. A stdio server has no way to answer that dialog,
so it simply blocks — startup goes from ~120 ms to however long the dialog sits
unanswered. Re-storing the token without `-A` resets the item's ACL and reintroduces the
prompt. If a dialog does appear, clicking **Always Allow** (not *Allow*) repairs the ACL
permanently; *Allow* answers only that one launch.

Lookup costs ~15 ms per launch, once per session.

On a headless server, use the file — there is no keyring daemon to unlock:

```sh
mkdir -p ~/.config/youtrack-onprem-mcp
printf %s 'perm-…' > ~/.config/youtrack-onprem-mcp/token
chmod 600 ~/.config/youtrack-onprem-mcp/token
```

Write it with `printf %s`, not `echo`. A trailing newline is stripped on read anyway, but
`echo` invites pasting stray whitespace that is invisible in an editor. Override the
location with `YOUTRACK_TOKEN_FILE`. For a systemd unit, prefer `LoadCredential=` and
export the value into `YOUTRACK_API_TOKEN` — source 1 wins and nothing touches the disk.

### Why not put the token in the MCP config?

Inlining a secret into an MCP client's config leaks it further than expected.
`claude mcp add -e TOKEN=…` writes the value into `~/.claude.json` *and* into every
rotating snapshot under `~/.claude/backups/` — files you never edited and would not think
to scrub. A secret store keeps one copy under OS access control instead.

If you would rather use the environment than a keyring, Claude Code expands `${VAR}` and
`${VAR:-default}` inside `command`, `args`, `env`, `url`, and `headers` — so
`"YOUTRACK_API_TOKEN": "${YOUTRACK_API_TOKEN}"` also keeps the literal value out of the
config file.

### 3. Private or incomplete certificate chains

TLS verification is **on** and there is no switch to turn it off. If your instance serves
a chain Node cannot verify — a private CA, or a reverse proxy that omits an intermediate
— supply the missing certificate rather than disabling the check:

```sh
# in ~/.config/youtrack-onprem-mcp/config
NODE_EXTRA_CA_CERTS=/absolute/path/to/ca.pem
```

`certs/` and `*.pem` are gitignored, so the repo is a fine place to keep it.

To find out what is missing:

```sh
openssl s_client -connect youtrack.example.com:443 -showcerts </dev/null
```

Browsers and `curl` paper over a missing intermediate — browsers chase the AIA extension,
macOS caches intermediates in the keychain — but Node's bundled CA store does neither, so
`fetch` fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` where everything else looked fine.
The proper fix is server-side: configure the reverse proxy to send the full chain, then
drop the setting.

Keeping verification on is not pedantry. When an instance is only reachable through a
VPN, the hostname off-VPN often still resolves — to the VPN gateway, which answers on 443
with its own certificate. The name resolves and the port is open, so this is not a clean
"host unreachable"; it is a *different host*. Verification is the only thing that stops
the bearer token from being sent to it. The handshake is refused in ~0.1 s and the tools
report:

```
Error: self-signed certificate in certificate chain (SELF_SIGNED_CERT_IN_CHAIN)

TLS verification failed. Either the instance serves a private or incomplete certificate
chain — point NODE_EXTRA_CA_CERTS at the missing CA — or something other than YouTrack
answered, which is what a dropped VPN looks like.
```

### 4. Register with your MCP client

```sh
claude mcp add yt -- ~/youtrack-onprem-mcp/bin/youtrack-onprem-mcp
claude mcp list          # expect: yt … ✔ Connected
```

Use an **absolute** path; `~` is not expanded in every context. The wrapper supplies the
URL, token, and CA path itself, so the config carries no secret at all:

```jsonc
// ~/.claude.json
{
  "mcpServers": {
    "yt": {
      "type": "stdio",
      "command": "/absolute/path/to/youtrack-onprem-mcp/bin/youtrack-onprem-mcp",
      "args": [],
      "env": {}
    }
  }
}
```

### 5. Verify

```sh
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"c","version":"1"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_current_user","arguments":{}}}' \
 | ./bin/youtrack-onprem-mcp
```

Your login in the response means the URL, token, TLS, and network path are all good.

## Updating

```sh
cd ~/youtrack-onprem-mcp
git fetch --tags
latest=$(git describe --tags --abbrev=0 origin/main)
git log --oneline "HEAD..$latest"   # what changed since your release
git checkout "$latest"
npm ci
```

Configuration and the token live outside the repo, so an update never touches them.
The server process lives as long as the client session, so restart the MCP client (or
reconnect the server, `/mcp` in Claude Code) to pick up the new version.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `YOUTRACK_URL is not set` | No config file and nothing exported. See *Configuration*. |
| `no API token found` | None of the four sources answered. The error lists all four with exact commands. |
| `exec: node: not found` | The spawning process has a minimal `PATH`. Put an absolute `PATH=` export at the top of `bin/youtrack-onprem-mcp`, or symlink node into `/usr/local/bin`. Version managers (nvm, fnm) are the usual culprit — their shims are not on a non-login shell's `PATH`. |
| `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` | Node older than 24. |
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | Your instance omits an intermediate. Vendor it and set `NODE_EXTRA_CA_CERTS`. |
| `SELF_SIGNED_CERT_IN_CHAIN` | A private CA, an inspecting proxy, or a VPN gateway answering instead of YouTrack. |
| `401` | Token revoked or mis-copied. Check with `curl -H "Authorization: Bearer <token>" "$YOUTRACK_URL/api/users/me?fields=login"`. |
| `403` on `list_projects` or `create_issue` | The account cannot read the project list. Issue tools still work for projects it can see, but `create_issue` needs the list to resolve the project short name. |
| `404` on a valid issue ID | Usually permissions, not a typo — the API hides what you cannot read. |
| `400` naming a field | An instance older than the field selectors used here. Check your version with `/api/config?fields=version,build` and open an issue. |

## Tools

Seven read, seven write.

| Tool | Purpose |
| --- | --- |
| `search_issues` | YouTrack query syntax → one line per match |
| `get_issue` | Full issue: description, custom fields, timestamps |
| `get_issue_comments` | Comment thread with authors and comment IDs |
| `get_issue_links` | Linked issues grouped by link type |
| `get_attachment_content` | List attachments, or fetch one |
| `list_projects` | Short name → full name |
| `get_current_user` | Resolves `me` in queries |
| `create_issue` | New issue from project, summary, description |
| `update_issue` | Replace an issue's summary or description |
| `apply_command` | YouTrack command language: state, assignee, priority, tags, links, … |
| `add_issue_comment` | Add a comment |
| `update_issue_comment` | Replace a comment's text |
| `delete_issue_comment` | Delete a comment the way the UI does — restorable by an admin |
| `add_attachment` | Upload a local file by absolute path |

Fields are not set one tool at a time. `apply_command` speaks the same language as the
command box in the web UI, so `State In Progress assignee me`, `Priority Critical`,
`tag urgent`, `relates to PROJ-45`, and `remove subtask of PROJ-10` are all one tool and
one round trip, and a command that does not parse or names an unknown value is refused
by YouTrack with the reason. Summary and description are the only things the command
language cannot touch, which is what `update_issue` is for.

There is no tool that deletes an issue, an attachment, or a comment permanently.

## Prompts (slash commands)

| Command | Does |
| --- | --- |
| `/mcp__yt__issue PROJ-123` | Issue + comments + links + attachments, summarised |
| `/mcp__yt__my_open` | Your unresolved issues, grouped by project |
| `/mcp__yt__recent PROJ [period]` | What moved in a project — `period` completes from YouTrack's named windows |
| `/mcp__yt__search <plain language>` | Translates a plain-language request into YouTrack query syntax |

The `yt` in `/mcp__yt__…` is the name the server is **registered** under, not anything
inside the code — `claude mcp add yt` is what makes the commands short. Registering it as
something else renames every command and tool accordingly.

Prompts cost nothing in context: unlike tool schemas, they are fetched only when invoked.
`recent` autocompletes project short names from the live project list, and falls back to
no suggestions if the API is unreachable rather than failing the command.

Only YouTrack's **named** date periods are emitted (`{This week}`, `{Today}`, …) rather
than hand-rolled relative-date arithmetic, so the generated queries stay valid across
versions.

## Design notes

**Results are text, not JSON.** Tool output is read by a model, not parsed by code, so
every response renders as plain lines — no braces, no quotes, no `$type` noise, and empty
fields omitted. A full issue costs ~550 bytes instead of ~2 KB.

**Every request pins `fields=`.** YouTrack returns only what is asked for. The selectors
in `youtrack.ts` are the main lever on context cost; widening one is never free.

**Attachments are size-guarded.** Images inline only under 4 MB; every other binary
returns metadata only. Without this, one 2.6 MB archive base64-encoded into a reply would
blow the context window.

**Ticket text is never clamped.** A description or comment thread is returned whole: a
truncated spec costs the tokens and still needs a second read, so cutting it saves
nothing. The `limit` on `get_issue_comments` bounds how many comments arrive, not how
long each one is.

Text files clamp at 24 KB (~6k tokens), **keeping both ends** rather than the first 24 KB.
A log's opening lines are boot banners while the failure sits at the end, so head-only
truncation reliably discards the interesting part. Measured on a real 29 KB `scan.log`:
the clamp preserves both the version header and the closing stack trace.

**The token never leaves the instance's origin.** Attachment URLs arrive inside YouTrack's
own payload, so an absolute one pointing elsewhere would carry the bearer token off-host.
Any URL whose origin does not match `YOUTRACK_URL` is refused before the request is made.

**Writes are annotated, not guarded.** Every write tool carries the MCP annotations that
say so, and a client such as Claude Code prompts before each call unless it has been
allowlisted. The server adds no confirmation of its own; the one it would add is the one
the client already shows.

**Writes return what changed.** A create, edit, or command answers with the issue's
refreshed one-line summary — the same format `search_issues` uses — so the model sees the
new state without a second read.

**Attachments are uploaded by path, not by content.** A model that has just written a
screenshot or a log to disk hands over the absolute path, and the bytes go straight from
the file to YouTrack without ever entering the context window.

**Comment deletion is the UI's deletion.** The comment is marked deleted and an admin can
restore it, exactly as when a person clicks delete in the browser. Nothing this server
does is less reversible than the same action in the web UI.

## Development

```sh
node src/index.ts   # starts on stdio; expects YOUTRACK_URL and YOUTRACK_API_TOKEN
```

To release, run `npm version <x.y.z> --no-git-tag-version` (it bumps `package.json` and
the lockfile), set the same version in the `McpServer` constructor in `src/index.ts`,
commit, then tag that commit `v<x.y.z>` and push the tag.

## License

MIT — see [LICENSE](LICENSE).
