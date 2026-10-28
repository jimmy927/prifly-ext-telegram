# prifly-ext-telegram

Your own Telegram account in prifly, as a client (the way Telegram Desktop is
one), through [TDLib](https://core.telegram.org/tdlib), Telegram's official
client library, running inside prifly's host process. It uses the
[`tdl`](https://github.com/eilvelia/tdl) binding and the prebuilt tdjson of
[`prebuilt-tdlib`](https://github.com/eilvelia/tdlib-types) for Windows, macOS
and Linux; neither needs an install script.

It is a toolbox for sessions: no launcher, boards or chips. You ask any
session in plain words ("what's new on Telegram", "read my chat with Anna",
"send Anna the report.pdf") and it answers through these **tools**:

| Tool             | What it does                                                                |
| ---------------- | --------------------------------------------------------------------------- |
| `telegram_chats` | Recent chats, with their chat ids and unread counts                         |
| `telegram_chat`  | One chat as Markdown, newest page first; `from_message_id` pages back       |
| `telegram_new`   | Messages others sent since the last call, per chat                          |
| `telegram_media` | Saves one message's picture or file to disk and gives its path              |
| `telegram_send`  | Sends a text, or a local file with an optional caption, to exactly one chat |
| `telegram_link`  | Signs in, signs out, says the status, forgets the api keys                  |

Reads run at once. They do not mark anything as read, so reading does not tell
anyone you did. **Every send asks you first** on a confirm card over the
session, showing the recipient and exactly the text, or the file and its
caption; it goes out only when you click Confirm. On a prifly that can edit on
the card (feature "confirm-edit") the text or caption is an editable area and
what you leave there is what goes out; the session is told you changed it and
what was sent. Emptying a text sends nothing. Cancel, and the session is told
"Not done: you cancelled" and nothing is sent.

## Read this first

- **You register your own api_id.** Telegram gives every developer their own
  `api_id` and `api_hash`; this extension ships none. Sign in at
  <https://my.telegram.org>, open "API development tools", create an
  application and copy the two values. The first `telegram_link` asks you for
  them on a card.
- **Third-party clients are watched.** Telegram puts accounts that log in
  through third-party clients under observation, and an account can get limits
  or be banned, especially one that sends a lot. Use an account you can afford
  to have limited, or accept the risk knowingly.
- **No bulk or automated messaging.** Telegram's
  [API terms](https://core.telegram.org/api/terms) forbid interfering with its
  basic functionality and bulk or unsolicited messaging. This extension sends
  nothing you did not confirm, one recipient per call, only into chats that
  already have messages, at most 30 an hour. Do not use it to message many
  people. When Telegram says to wait (`FLOOD_WAIT`), the tool tells you how
  long and stops; nothing is retried.
- **Untested against a real account.** The tests run over fakes; the sign-in,
  reading and sending were never tried against Telegram itself. The real
  library loads and starts (checked on Windows with a production,
  `--ignore-scripts` install); a first sign-in on a real phone is the first
  real test.

## Sign in

1. Enable the extension in prifly's Extensions dialog.
2. Ask a session to link Telegram (it calls `telegram_link` with `sign_in`).
   Cards open over the session, one after another: your api_id, your api_hash
   (the first time only), your phone number with country code, the login code
   Telegram sends to your other Telegram app or by SMS, and your two-step
   verification password if the account has one.
3. The status line says "Signed in as ...", and it stays signed in across
   prifly restarts.

What you type goes from the card into TDLib inside the extension. It never
passes through the model, a tool argument, a log line or a status line. A
wrong code or password asks again on a card (three tries); a code card you
close leaves Telegram waiting for the code, and `sign_in` carries on from there.

**One gap:** prifly's `api.dialog` is a plain text box with no masked field, so
the login code and the two-step password are visible on the card while you
type them. They are not stored.

Messages the extension tells you in words: not set up (no api_id), not signed
in, waiting for the login code or the password, wrong code or password, a flood
wait ("wait 12 minutes"), the network or TDLib not reachable, no chats, no new
messages.

**Sign out** (`sign_out`, confirmed on a card) logs this device out on
Telegram and deletes the local database. **Forget keys** (`forget_keys`) removes
the api_id and api_hash, once signed out.

## Where things are kept

| What                                               | Where                                                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| api_id and api_hash                                | `api.secrets` (sealed by prifly), never on disk                                                  |
| Login and TDLib's copy of your chats and messages  | `data/db/` in the extension's folder, TDLib's own database (git-ignored)                         |
| Downloaded files                                   | `data/files/`; a copy for the session in its scratchpad (`telegram/<chat>/`), else `data/media/` |
| Who is signed in, and where `telegram_new` stopped | `api.state` (moves with prifly's data)                                                           |

## Needs

A prifly that offers `api.secrets` (feature "secrets"); on an older one the
status line says "Telegram needs a newer prifly" and no tool is registered.
Sending and signing out also need `api.confirm` (feature "confirm"); without it
they refuse. `telegram_new` needs `api.state`. Editing on the card needs
`confirmEdit` (feature "confirm-edit"). The status line needs `api.status`.

## Development

`bun install`, then `bun test`, `bun run typecheck` and `bun run check`.
`@prifly/extension-api` (the types, v0.8.0) comes from its git repository; it
does not declare `confirmEdit` yet, so `types.ts` adds it. Only `client.ts`
imports `tdl`, and only when the extension first needs Telegram; everything
else takes a client factory, so the tests run against a fake TDLib client
(`test/fake-td.ts`) and a fake `api` (`test/fake-api.ts`) and never load
tdjson or touch the network.

| File                                 | What it is                                                                              |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| `telegram.ts`                        | The link: keys, the lazy TDLib client, requests with a timeout, send outcomes           |
| `client.ts`                          | The only `tdl` import; the real client factory                                          |
| `signin.ts`, `link-tool.ts`          | The sign-in loop over TDLib's authorization states; `telegram_link` and the status line |
| `read.ts`                            | `telegram_chats`, `telegram_chat`, `telegram_new`                                       |
| `media.ts`, `send.ts`                | `telegram_media`; `telegram_send` and its card                                          |
| `format.ts`, `errors.ts`, `types.ts` | Markdown for chats and messages; TDLib errors in words; our slice of TDLib's types      |
| `prompt.md`                          | What every session is told about the tools                                              |

## License

MIT, see `LICENSE`.
