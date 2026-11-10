# ntn-link

Short, readable links for public Notion pages. Turn
`https://thsm.notion.site/Our-trips-413d447ac4b180169985c93eea7f02f9`
into `https://<service>/thsm/our-trips`, with a proper preview card when the link
is pasted into a chat. No dependencies, one file, Node 20+ or Bun.

```sh
npx ntn-link https://thsm.notion.site/Our-trips-413d447ac4b180169985c93eea7f02f9
# stdout: https://<service>/thsm/our-trips
```

## Usage

```
ntn-link <notion-url> [--slug name] [--fast] [--copy] [--origin URL]
ntn-link ls <workspace>
ntn-link rm <workspace>/<slug>
ntn-link set <workspace>/<slug> [--title T] [--description D] [--slug S]
                                [--fast on|off] [--canonical self|notion]
```

| Option           | Meaning                                                                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--slug name`    | Choose the slug (`a-z`, `0-9`, `-`, up to 64). Default: derived from the title.                                                                             |
| `--fast`         | Print the fast static copy's `/read` link instead of the redirect link (the fast page itself is created by default; turn it off with `set ... --fast off`). |
| `--copy`         | Copy the printed link with `pbcopy`, `wl-copy`, `xclip` or `xsel` if present; otherwise warns.                                                              |
| `--origin URL`   | Service origin. Default: `$NTN_LINK_ORIGIN`, else the built-in default.                                                                                     |
| `set --title ""` | An empty `--title` or `--description` removes that override.                                                                                                |

**stdout carries only the result**: the link for the create command, tab-separated
`slug<TAB>title<TAB>link` rows for `ls`. Progress, prompts, errors and the log path go
to stderr, so `link=$(ntn-link <url>)` and pipes just work.

## Ownership: the first link in a workspace

A namespace (`/thsm/...`) belongs to whoever proves they control that Notion
workspace, not to whoever asks first. The first time you create a link in a workspace
the CLI:

1. asks the service for a challenge and prints a public code such as `ntn-verify-abc1234567`;
2. asks you to put that code into the title of any public page of the workspace
   (the page you are linking works), and press Enter. If you used another page, paste
   its URL at the prompt instead;
3. lets the service check the page title, then stores the resulting **owner key**;
4. if the code is on the page you are linking, asks you to remove it again (and checks
   that Notion no longer shows it) before creating the link, so neither the preview
   nor the slug carries the code.

The private half of the challenge (the `claimToken`) is kept in memory for that one
run and is never printed, logged or written to disk. Later runs need no verification.
If the key is lost or stops working, the next create command runs the same flow with a
fresh challenge and replaces the key (the service then removes links whose pages are no
longer public). Without a terminal the verification cannot be answered, so run the
command once interactively.

Owner keys live in `$XDG_CONFIG_HOME/ntn-link/keys.json` (default
`~/.config/ntn-link/keys.json`), file mode `0600` in a `0700` directory, saved per
service origin and workspace: a key issued by one service is never sent to another one
(for example when you pass a different `--origin`). Parallel runs are safe (the file is
updated under a lock). The key is sent only as an `Authorization: Bearer` header, and
only over HTTPS (plain HTTP is accepted for `localhost` development only).

## Log file

Every run (except `--help` and `--version`) writes a detailed log to a unique file
`/tmp/ntn-link-<timestamp>-<pid>.log` (mode `0600`) and prints its path to stderr
at the start and at the end, also on failure. Owner keys, claim tokens and
authorization headers are never written to it.

## Exit codes

| Code | Meaning                                                                             |
| ---- | ----------------------------------------------------------------------------------- |
| 0    | Success                                                                             |
| 1    | Other server error or unexpected failure                                            |
| 2    | Usage error (bad arguments)                                                         |
| 3    | Ownership check needed but there is no terminal to answer it                        |
| 4    | Configuration error (no home directory for the key file)                            |
| 5    | The page cannot be linked (`not_notion_url`, `not_public`, `unsupported_workspace`) |
| 6    | Slug problem (`slug_taken`, `slug_reserved`, `slug_invalid`)                        |
| 7    | Not authorized (`unauthorized`, `needs_verification`, `namespace_claimed`)          |
| 8    | Rate limited (`rate_limited`)                                                       |
| 9    | Challenge failed (`challenge_expired`, `challenge_invalid`, `nonce_not_found`)      |
| 10   | Network failure                                                                     |

Server error messages are printed as is.

## Environment

- `NTN_LINK_ORIGIN`: service origin (overridden by `--origin`).
- `XDG_CONFIG_HOME`: base directory for the key file.

## License

MIT
