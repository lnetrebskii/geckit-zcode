# Lessons carried over from geckit-minimax-tmux

Source: https://github.com/lnetrebskii/geckit-minimax-tmux, all 14 commits read
(three of them have empty messages; their lessons come from the diffs).
Each item names the commit that had to add it after the fact. A new ZCode
provider satisfies every applicable item from its first version.

## Applies to any transport

1. Manifest: no `transport` field; `id === family === plugin:<slug>`; entry
   `index.mjs`; every LlmProvider method and boolean flag present. Keep a copy
   of GeckIt's loader validation as a test fixture. (12cd068 — the host
   refused to install a manifest with `transport`.)
2. Commit the bundle; CI rebuilds and fails on `git diff --exit-code index.mjs`.
   (e556f45)
3. Images supported from day one: validate media and base64, private 0600
   temp files, removed on close. (507704a)
4. Plan quota: one cached reader, concurrent reads coalesced, stale after
   10 minutes, at most one refresh a minute, `plan`/`usage` broadcast after
   every `ended`. (1f85ef8, 9851c00)
5. Zero is a real balance, unknown stays unknown, "no subscription" and
   "temporarily unavailable" are said explicitly; no invented percentages;
   no subscription quota for signed-out or API-key users. (9851c00, 9854624)
6. Live permission change: `permit()` takes effect before the next turn,
   never interrupts a running one; the mode actually in force is reported back.
   (1f85ef8)
7. `resumeCommand` set; `links()` matches the host renderer: labelled,
   deduplicated, newest first. (7e6fa16)
8. Boundaries: namespaces validated in both directions; non-finite numbers
   omitted; idempotent shared `close()`; unsupported options refused;
   `managerPrompt` passed through. (4a829bf)
9. Pinned snapshot of host contract types, events tested against it, and a
   coverage document giving each type a disposition. (4a829bf)
10. Background tasks with `control(stop_task)`; model, effort and mode state
    signals; `doing`/`writing`/`said`/`wrote`; images restored on `read`;
    `begun` only for turns the plugin did not start. (9854624)
11. `setInstructions` applied as a scoped launch argument, never by editing
    the user's global config; `GECKIT_*` stripped from the CLI environment.
    (9854624)
12. Billing source detected (subscription / API key / custom provider);
    unknown never becomes "subscription"; fork applies the requested model;
    `limits` does not depend on `models` having been called. (9854624)
13. Sign-in offered from conversation cards: native login in its own process,
    URL host validated, exit status plus account verified, cancel and timeout
    handled, nothing pasted into the agent prompt; 401 → `signedOut`,
    429 → `limit`. (71089d2)
14. Native goals with `autoStartingGoals`, driven by an attached driver; bare
    `setGoal` refuses; approval cards keep working during the goal request.
    (9854624, ba44f42)
15. A submission the CLI refuses before a turn starts ends the turn as
    `limit`/`failed`; the driver never waits forever. (ba44f42)
16. Long instructions or manager prompts never go on a command line: launch
    through a private 0600 script, removed on close and on failed start.
    (dbbe4d9)
17. Auto answers tool approvals with the conversation-scoped grant only,
    re-checks the request right before answering, honours Stop and a switch
    to Manual, never answers questions, rule confirmations or unknown
    requests, never chooses "always". (34c3f30)
18. The user's own message is not echoed back: GeckIt already shows it, so the
    first new native user message after the pre-send baseline is suppressed,
    matched by id, not text. (6d83045)
19. A turn ends only when the native side reports idle, not on transcript
    silence alone. (e556f45)
20. Logs carry ids and outcomes only, never prompts, replies or credentials.
    (all commits)
21. Tests: a fake CLI exercised through the real process boundary, a copy of
    the host loader, contract fixtures; a failing regression test before
    every fix. (all commits)

## Applies only to a terminal (tmux) transport

22. Approval and question cards are cut out of the dialog frame, not the whole
    screen; single-line title, multiline evidence in `detail`; `asks` plus a
    `card` item. (507704a)
23. Card signatures independent of transcript and redraws; repeated cursor
    markers and wrapped headers tolerated; every native option, key,
    sub-confirmation and Back kept. (507704a, 6d83045)
24. Images pasted as absolute paths, placeholder awaited in the composer only.
    (507704a)
25. Paste through a unique tmux buffer with bracketed paste, guard checked
    between steps, control characters refused, buffer always deleted; inject
    only while working, draft cleared on failure. (e556f45, 507704a)
26. Refused submission: the restored draft is cleared so the next message is
    not merged into it. (ba44f42)
27. tmux discovery on PATH and known directories, else a sha256-verified static
    binary on a dedicated `-L` server. (e556f45)
