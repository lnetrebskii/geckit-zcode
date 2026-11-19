# Plan: ZCode provider for GeckIt over the public headless CLI

Status: implemented 2026-11-19 (see INTEGRATION-AUDIT.md). Decisions taken during
implementation are listed at the end and override the text above them. Replaces the first attempt, which drove
`zcode app-server --stdio` (ZCode Desktop's private host protocol) and is
abandoned: it needs a hidden config variable, host-supplied auth headers on
every model request and a model catalogue only Desktop has.

## What ZCode the person has

`zcode` is `zcode-app-cli` 3.18.2-47 from npm (community package
`kingsword09/zcode-cli`, runtime 0.17.1 taken from ZCode Desktop). Its
documented host contract (`docs/HOST_INTEGRATION.md`, version 1) is the only
surface this plugin uses:

- start the published `zcode` bin only, never `vendor/*`;
- do not parse the TUI screen; the machine interface is
  `zcode -p … --output-format stream-json` (JSONL plus a final `result`);
- cancel with SIGINT/SIGTERM; 130/143 mean cancelled, not success;
- supported environment: `ZCODE_NODE`, `ZCODE_CLI_SETTINGS_FILE`,
  `ZCODE_SESSION_DB_PATH`, `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`, …;
- hooks under `hooks.events.<Event>` in the CLI settings file.

## Verified live (2026-11-19, scratch folders, 4 small model requests)

1. `zcode -p "…" --output-format stream-json` streams token-level events:
   `turn.started`, `model.streaming` (`start`, `reasoning_*`, `text_*`,
   `tool_input_*`, `tool_call`, `finish`), `tool.updated`, `session.updated`,
   `permission.requested/resolved`, `turn.completed`, then
   `{"type":"result", sessionId, turnId, response, usage}`. Every event
   carries `sessionId` and `turnId`. Process start to model request ≈ 1.4 s.
2. `--resume <sess_id>` continues the same native session (`session.resumed`).
3. `--mode build` headless: a tool needing approval emits
   `permission.requested` and is denied at once
   ("No permission client configured"). No interactive approvals.
4. A `PreToolUse` command hook declared in a settings file passed through
   `ZCODE_CLI_SETTINGS_FILE` runs headless, receives
   `{toolName, toolInput, riskLevel, sideEffectScope, mode, sessionId, turnId,
   toolCallId}` on stdin, and its
   `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}`
   lets the tool run (file was written). A `PermissionRequest` hook did not
   fire headless; `PreToolUse` is the approval channel.
5. Sign-in is the CLI's own (`account:zai-individual-coding-plan`, GLM-5.3,
   1 M context). The plugin never sees tokens or headers.

Side effect: the runs left four short sessions in the person's ZCode session
database, all in scratch folders.

## Architecture

```
src/
  provider.mjs        GeckIt LlmProvider adapter; ids namespaced plugin:zcode:
  zcode-cli.mjs       find zcode + a Node ≥ 22.19 for it; env hygiene; version
  zcode-turn.mjs      one turn = one `zcode -p` process; JSONL → Heard
  zcode-events.mjs    pure mapping of stream-json events to items/signals
  zcode-approval.mjs  per-driver Unix socket; settings copy with our hook
  zcode-journal.mjs   plugin-owned record of sessions and items (list/read)
  zcode-quota.mjs     plan quota (see open question Q1)
  zcode-login.mjs     sign-in cards around `zcode login zai --no-browser`
hook/
  pretooluse.mjs      the hook; inert unless its socket variable is set
test/
  fake-zcode.mjs      replays recorded stream-json fixtures, runs our hook
  fixtures/live/*.jsonl  the live runs above, paths scrubbed
  fixtures/geckit-*.mjs  GeckIt loader validation and contract snapshot
```

### Finding and starting zcode

- Order: `GECKIT_ZCODE_COMMAND`, PATH, then npm global bins
  (`~/.nvm/versions/node/*/bin`, fnm's `node-versions/*/installation/bin` and
  `aliases/default/bin`, Homebrew, `npm prefix -g`).
- GeckIt is a GUI app with a short PATH, and the person has `zcode` under
  Node 20 too, where it crashes (`node:sqlite`). The launcher's shebang uses
  `env node`, so the child PATH starts with the directory holding the chosen
  `zcode` and its own Node; that Node must be ≥ 22.19 or the account reports
  why it is unusable.
- `cwd` and `--cwd` = project root; `GECKIT_*` stripped; local roots only.
- `program()` parses both lines of `zcode --version`.

### A turn

`send(text, images, before)` spawns
`zcode -p <text> [--resume <id>] --mode <m> [--model <p/m>] [--effort <e>]
[--attach <file>…] --output-format stream-json` with stdin closed.

- `before` blocks are joined ahead of the text. If argv length is a concern
  for huge pastes (Q4), the text goes through a 0600 file the prompt points to.
- Images: validated base64 → 0600 temp files → `--attach`; removed after.
- Mode: Manual → `build` + approval hook; Auto → `yolo`; Plan → `plan`.
  `started.mode` reports GeckIt's own word (`manual`/`auto`/`plan`), never
  ZCode's, or GeckIt flips Auto back to Manual.
- `permit()` changes the mode of the next turn; a running turn keeps its mode,
  but the hook reads the current mode on every request, so switching to Auto
  answers a waiting card with allow and later requests are allowed at once.
- Stop: SIGINT to the process; it must exit; `ended stopped` follows exit.
- One `ended` per turn: done on `turn.completed` + exit 0 + `result`;
  stopped on 130/143; failed otherwise. Error kinds: 401/auth → `signedOut`,
  429/quota → `limit` with the CLI's text; a run with no `result` is failed.
- A refusal before the model is reached (no sign-in, no quota) ends the turn
  the same way; the driver never waits on a process that has exited.
- `inject` is not offered: headless has no mid-turn input. GeckIt queues.

### Events → GeckIt

- `text_delta` → live `theirs` item per `assistantMessageId`;
  `reasoning_delta` → `thought`; `tool_call` + `tool.updated` → `did` with
  `live`, detail from output; Write/Edit paths → `writing`, completed → `wrote`.
- `turn.started.input` is the person's own message: never emitted live
  (GeckIt already shows it), matched by `inputId`, not text.
- `usage` + `contextWindow` → `spend`; model/effort actually used → signals.
- `started` once per driver, `session` = `plugin:zcode:<sess_id>`; a new
  conversation learns its native id from the first event, and GeckIt renames
  the provisional id (`create` returns `plugin:zcode:new-<uuid>`).
- `begun` only for turns the plugin did not start (goal continuation).

### Approvals (Manual)

- Each driver owns a private 0600 Unix socket and a private settings file:
  the person's current `~/.zcode/cli/setting.json` read fresh at every launch,
  with our `PreToolUse` hook appended to theirs (their hooks kept, never
  edited). `ZCODE_CLI_SETTINGS_FILE` points at the copy; the copy's own
  directory keeps the launcher's migration markers away from theirs.
- The hook gets the socket path in its environment. Without it the hook exits
  without a decision, so it is inert anywhere else.
- Read-only tools (`sideEffectScope: none`) get no decision. Others: Manual
  sends an `asks` card (`command` for Bash with the real command, `write` with
  paths for Write/Edit, `web` with the real URL, `other` otherwise, `line` =
  the tool row id) and waits; allow/deny comes back as the hook's output.
  "Session" grants are remembered per driver and answered by the hook itself.
- Hook timeout 10 min (setting `timeoutMs`); on timeout or a dead socket the
  hook denies with a reason the model sees.
- Stop or `end()` denies every waiting request.

### History and lists

There is no public command that lists ZCode sessions or prints a transcript.

- `create`, `read`, `has`, `links`, `list`, `search` answer from the plugin's
  own journal of what it saw in the stream, kept in a plugin data folder,
  never prompts in logs.
- Sessions made outside GeckIt are not listed in this version (said in the
  README). `resumeCommand` = `zcode --resume {id}` lets the person continue
  any of them in a terminal.
- `rename`: GeckIt-side title in the journal. `delete`: forgets it in the
  journal only, and says so; the native session stays in ZCode.
- `fork`: not offered.

### Goals

`--target <text>` sets or runs the session goal headless; `--target-replace`
replaces one. `nativeGoals` only if the stream reports goal status (Q3);
otherwise goals stay GeckIt's own.

### Account, sign-in, quota

- `account()`: here / program / Node usability. Signed-in is unknown until a
  turn says otherwise (tri-state; never guessed).
- On `signedOut`, cards offer `zcode login zai` or `zcode login bigmodel`
  in a separate process with `--no-browser`; the URL is validated before it
  is shown; exit status decides; cancel and timeout clean up.
- Quota: Q1. Until answered, `limits()` returns context windows plus an
  explicit `unavailableReason`. Zero ≠ unknown ≠ unavailable; nothing invented.

### Instructions

`instructions: "own"` and `setInstructions` as a no-op until Q2 is answered:
the plugin does not write to the person's AGENTS.md or ZCode settings.

## Lessons applied

Every applicable item of [minimax-lessons.md](minimax-lessons.md) (1–21) is a
requirement of the first version and has a test; the tmux-only items (22–27)
do not apply. In particular: no `transport` in the manifest (1), committed
bundle checked in CI (2), refusal before a turn ends it (15), long prompts
never on a shell command line (16), Auto grants only per conversation (17), no
echo of the person's message (18), ids-and-outcomes-only logs (20).

## Contract mistakes of the first attempt not to repeat

- `started.session` bare instead of namespaced → GeckIt loses the conversation.
- `started.mode` in ZCode's words → Auto silently becomes Manual.
- One `ended` per driver instead of per turn → second turn hangs.
- Snapshot reads tearing down the live listener → turns go deaf.
- `setGoal` before the first message / `clearGoal` always throwing.

## Steps

1. `git init`; commit the current state as the starting point; remove the
   app-server code, the copied Codex runtime and their fake servers.
2. Record and scrub fixtures from the live runs; fake `zcode` that replays
   them, honours `--resume`, `--mode`, SIGINT, and runs our hook.
3. `zcode-cli.mjs` and `zcode-events.mjs` with unit tests on fixtures.
4. `zcode-turn.mjs` + provider `hold`: send, stop, per-turn end, errors.
5. Approval hook and socket; Manual/Auto/Plan; tests through the real hook.
6. Journal-backed list/read/links/rename/delete.
7. Login cards; quota per Q1; account tri-state.
8. GeckIt loader fixture and contract snapshot from GeckIt main; README,
   UPSTREAM.md, INTEGRATION-AUDIT.md; CI with the bundle check.
9. Live check in a scratch project with the person's consent: one Manual turn
   with a card, one Auto turn, Stop, resume in the terminal.

## Open questions

- Q1. Plan quota: is there a documented source (CLI output, Z.ai API) that
  works with the person's OAuth sign-in? If not, `unavailableReason` only.
- Q2. Instructions: does the CLI accept an appended system prompt per run? If
  not, GeckIt instructions are not applied in this version.
- Q3. Goals: what does stream-json emit for `--target` runs?
- Q4. Is there a documented way to pass the prompt other than argv?
- Q5. Plugin data folder for the journal: does GeckIt give plugins one, or
  does the plugin choose its own under the user data directory?

## Decisions taken during implementation (2026-11-19)

- Q1 quota: SOLVED (macOS). The account's own OAuth token, decrypted from the
  person's ZCode keychain store, authorizes `GET /api/monitor/usage/quota/limit`
  (the endpoint ZCode Desktop uses). `src/zcode-quota.mjs` reads it, maps the
  windows and degrades to `unavailableReason`; `GECKIT_ZCODE_NO_QUOTA=1` disables
  it. Verified live 2026-11-19.
- Q2 instructions: no per-run system prompt flag; `setInstructions` is a no-op.
- Q3 goals: `--target` cannot be combined with `-p`; `-p "/goal <objective>"` runs a
  goal and prints only a final `{sessionId, response}` record, no stream.
- Q4 prompt: argv only (no shell involved, so no quoting hazard).
- Q5 journal: `<userData>/provider-data/plugin-zcode/`, derived from the log path.
- Session ids: `--resume` with an unknown id fails ("Session not found") and
  sessions made by local slash commands are not persisted, so a session cannot
  be created ahead of the first message. `create` returns `new-<uuid>`, and the
  provider declares `nativeGoals: true` because only then does GeckIt move a
  conversation to the id `started` names.
- Auto runs as `build` with the hook allowing every request, so switching
  modes mid-turn takes effect at once; Plan is left entirely to zcode.
- The `PermissionRequest` hook does not fire headless; `PreToolUse` is used.
