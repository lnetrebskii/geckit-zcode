# ZCode provider for GeckIt

Runs your own `zcode` (the `zcode-app-cli` package) as a GeckIt assistant through its public headless interface: one `zcode -p … --output-format stream-json` run per message, in the project folder, with your existing ZCode sign-in, models and settings. No terminal is scraped, no ZCode Desktop internals are used, and no token or key passes through the plugin.

## Install

1. Install the CLI and sign in once in a terminal:
   ```sh
   npm install -g zcode-app-cli
   zcode login
   ```
   It needs Node 22.19 or newer.
2. In GeckIt open **Settings → Libraries → Add library** and enter `https://github.com/lnetrebskii/geckit-zcode`.
3. Enable **ZCode** under **Settings → Assistants** and choose it in a local project.

The plugin finds `zcode` through `GECKIT_ZCODE_COMMAND` (an absolute path), then PATH, then npm global folders (nvm, Homebrew, `~/.local/bin`, `~/.npm-global/bin`). A `zcode` installed under a Node older than 22.19 is skipped, because its runtime cannot start there; the account says so when it is the only one.

## How it works

- **A message** starts `zcode -p <text> [--resume <sess_id>] --mode … [--model …] [--attach <image>…] --output-format stream-json` with the project as its working directory. Replies, reasoning, tool lines, file writes, model and context use stream in as zcode reports them.
- **A new conversation** gets its `sess_…` id from zcode on the first message; GeckIt then moves the conversation to that id. `zcode --resume <id>` continues it in a terminal.
- **Turns** end once, when the run exits: done, stopped (Stop sends SIGINT), signed out (401/403), limit (429/quota) or failed. A run with no final `result` record is never taken as success.
- **Manual** runs zcode in `build` mode. Each tool request with side effects becomes a GeckIt card, through ZCode's own `PreToolUse` hook: the plugin starts zcode with `ZCODE_CLI_SETTINGS_FILE` pointing at a private copy of your `~/.zcode/cli/setting.json` with one hook added, and the hook asks GeckIt over a private Unix socket. Your settings file is only read; your own hooks keep their on/off state. A hook that cannot reach GeckIt denies.
- **Auto** runs the same way and answers every tool request with allow, for this run only; no permanent rule is written. Switching to Auto answers a card that is waiting.
- **Plan** runs zcode in `plan` mode and leaves its decisions to zcode.
- **Goals** run as `zcode -p "/goal <objective>"`. zcode prints only the final answer for goal runs, so a goal turn shows "working" until it finishes. Approval cards still appear during it.
- **Images** (PNG, JPEG, GIF, WebP) are written to private temporary files, attached with `--attach` and removed after the run.
- **History, lists and search** come from the plugin's own journal of what it saw, kept beside GeckIt's provider logs in `provider-data/plugin-zcode/`. zcode has no public command that lists sessions, so conversations started outside GeckIt are not listed; open them with `zcode --resume`.

## What is not offered

- **Plan quota.** zcode does not report it to other programs. GeckIt shows the reason instead of a number; check the quota in ZCode Desktop.
- **Model picker.** zcode has no public model list; it runs the model chosen in ZCode.
- **Send now** during a turn. Headless zcode takes no input mid-run, so GeckIt queues the message.
- **Fork, Remote Control, browser selection, text correction, MCP listing.**
- **GeckIt instructions.** The CLI accepts no extra system prompt per run, and the plugin does not edit your files.
- **Questions the model asks** (`AskUserQuestion`) are not answerable headless.
- **Delete** removes the conversation from GeckIt and the journal; the native session stays in ZCode.

## Logs

`<GeckIt userData>/provider-logs/plugin-zcode.jsonl` records session ids and outcomes (`turn.started`, `approval.asked`, `turn.ended`, …), never prompts, replies, tool input or credentials.

## Development

Node 22+:

```sh
npm ci
npm run build
npm test
```

Tests replay recorded live streams (`test/fixtures/live`) and drive a fake `zcode` (`test/fake-zcode.mjs`) that speaks the same stream-json and runs the real approval hook. No model is called. Commit the rebuilt `index.mjs`: GeckIt installs it as committed and runs no scripts. CI fails when the committed bundle differs from a fresh build.

See [docs/plans/headless-provider.md](docs/plans/headless-provider.md) for the design and its verification, [INTEGRATION-AUDIT.md](INTEGRATION-AUDIT.md) for the contract coverage, and [UPSTREAM.md](UPSTREAM.md) for provenance.
