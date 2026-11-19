# Integration audit

Scope: `plugin:zcode` ↔ GeckIt apiVersion 1 at `9a3abda` (v1.265), over `zcode-app-cli` 3.18.2-47 headless. Verified 2026-11-19.

## LlmProvider

| Member | Disposition |
| --- | --- |
| `available`, `localOnly`, `subscriptionOnly`, `images`, `waitForExit` | `true` |
| `remoteControl` | `false` |
| `nativeGoals` | `true`: needed so GeckIt moves a new conversation to the `sess_…` id zcode assigns (`started.session`); goals run as `/goal` |
| `account` | here / program (version, install source, resolved path); `signedIn` unknown until a turn says otherwise; `usage.unavailableReason` for the plan quota |
| `program` | `zcode --version`, both layers |
| `models` | `undefined`: no public model list |
| `limits` | windows from `model-overrides.mjs` only, `unavailableReason` |
| `list`, `search`, `has`, `read`, `links` | the plugin's journal of conversations it held |
| `hidden` | `[]` |
| `create` | provisional `new-<uuid>`, renamed through `started` |
| `fork` | refused |
| `goal`, `setGoal`, `clearGoal` | goal run through the held driver; status beyond "active" is not reported by headless zcode, so none is invented; `clearGoal` forgets it in the journal |
| `pauseGoal`, `resumeGoal` | not offered |
| `hold` | one headless run per message (see Driver) |
| `rename` | journal title |
| `delete` | journal only; the native session stays in ZCode (README says so) |
| `remote`, `correct` | refused |
| `mcp`, `browsers` | `undefined` |
| `setInstructions` | no-op: the CLI takes no per-run system prompt and the person's files are not edited |
| `dispose` | ends every driver: runs interrupted, sockets and private settings removed |

## Driver and signals

| Member / signal | Disposition |
| --- | --- |
| `send(text, images, before)` | `before` blocks joined ahead of the text; images through `--attach`; a send during a run is queued |
| `answer` | `once`/`session` → allow, `no` → deny, other text → deny with the person's words as the reason |
| `permit(mode)` | next runs use it; switching to Auto allows waiting requests |
| `stop` | SIGINT, then SIGTERM/SIGKILL after 5 s/10 s; queue cleared |
| `end`, `leave` | interrupt, wait for the exit, close the approval channel, `left()` |
| `inject`, `control` | not offered |
| `started` | once per driver, namespaced session, GeckIt's own mode word, `key: false` |
| `model` | the provider/model zcode reports |
| `spend` | context used and window from the stream and the final record |
| `doing`, `writing` | from tool start and Write/Edit calls |
| `asks`, `resolved` | from the PreToolUse hook; `line` points at the tool row |
| `begun` | only for goal runs, which GeckIt did not start with `send` |
| `ended` | exactly once per run: done / stopped / signedOut / limit / failed |
| `goal`, `task`, `usage`, `plan`, `held`, `retry`, `mode`, `reasoning` | not emitted: headless zcode does not report them |

Items: `theirs` and `thought` per assistant message, `did` per tool call (live, then with its output), `wrote` for successful writes. The person's own message is never echoed live (GeckIt already shows it); it is journaled for `read`.

## Verification

- 16 automated tests: recorded live streams replayed through the event mapping; a fake `zcode` driven end to end, including the real hook process and Unix socket; GeckIt's loader checks against the built `index.mjs`.
- Live, with the person's consent, in scratch folders: plain reply; build-mode denial without the hook; hook-allowed write; goal run output; unknown session id refusal; and a full plugin run (Manual card → allowed → file written, second turn resumed, journal and logs checked) under a GUI-like PATH. Seven small model requests in total.
- Not verified: the GeckIt renderer with this library installed, sign-in expiry and quota exhaustion against the real service (mapped from error text), and long goal runs.
