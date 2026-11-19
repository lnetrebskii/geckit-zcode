# Provenance

- **zcode CLI.** Built against `zcode-app-cli` 3.18.2-47 (runtime 0.17.1) from npm, community package https://github.com/kingsword09/zcode-cli. Only its documented host contract is used (`docs/HOST_INTEGRATION.md`, contract version 1; `docs/HEADLESS.md`): the published `zcode` bin, `-p`, `--resume`, `--mode`, `--model`, `--attach`, `--output-format stream-json`, `ZCODE_CLI_SETTINGS_FILE` and `PreToolUse` hooks in the CLI settings. No file under its `vendor/` folder is run or read.
- **Recorded streams.** `test/fixtures/live/*.jsonl` were recorded on 2026-11-19 from real runs in scratch folders. Local paths are replaced with `/work`, `/scratch` and `/Users/me`; they contain no credentials.
- **GeckIt contract.** https://github.com/anetrebskii/geckit at `9a3abda` (v1.265, 2026-11-18), apiVersion 1: `client/src/main/sessions/{provider,heard,plugins,rule}.ts` and `client/src/shared/api.ts`. `test/fixtures/geckit-loader.mjs` transcribes the loader's manifest and contract checks from that commit.
- **Lessons.** Requirements carried over from https://github.com/lnetrebskii/geckit-minimax-tmux are listed in `docs/plans/minimax-lessons.md`.
- **Not used.** An earlier draft drove `zcode app-server --stdio`, ZCode Desktop's private host protocol. It was removed: it needs Desktop-only configuration and host-supplied credentials.
