# The Handoff API

Use the Claude Code on your computer from your own programs, scripts and phone shortcuts:
- send a prompt and get the answer;
- pick a session and continue it with its context;
- attach photos and files;
- choose the model and effort;
- approve what Claude wants to do;
- compare models;
- use it from any OpenAI-compatible chat app.

It's one of Handoff's three parts (see [Choosing what to run](services.md)). Like the web app, it works only while the computer and Handoff are running.

**Everything in one place:** `https://<your Handoff>/api/v1/docs` is a Swagger page listing every endpoint, with **Try it out** after you paste a key under **Authorize**. The web app also has a "Try it" page (menu → API access → Try it) that shows the same call as curl, Python and JavaScript. The machine-readable description is `/api/v1/openapi.json`.

> Keys are for your own programs and devices. Sharing access to your Claude plan with other people can break its terms.

## 1. Turn it on, and make a key

- **Turn it on:** `HANDOFF_API=true` in `.env` (or answer yes to "Use the API?" in `npm run setup`). The web app can also switch it on and off (menu → API access); that asks for your 2FA code or password.
- **Make a key:**
  - in the web app: menu → API access → New key (asks for your 2FA code or password); or
  - in a terminal on the computer: `node scripts/api-key.js create --name "iPhone shortcut" --preset phone`.

  The key (`hk_…`) is shown **once**. Only a hash of it is kept, in `data/api-keys.json`. `node scripts/api-key.js list` and `revoke <name>` manage keys from the terminal; a running Handoff picks changes up at once.
- **Send the key** with every request, as `Authorization: Bearer hk_…` or `X-Api-Key: hk_…`. Never put it in the URL.

**What a key may do** (all set when you make it):

| Setting | Choices | Default |
|---|---|---|
| Scopes | `read` (projects, sessions, messages, search, models), `chat` (send prompts), `approve` (allow or deny requests, answer questions), `files` (files and changes; with every project, the computer's folders), `git` (commit, push, discard; needs `HANDOFF_GIT_ACTIONS`) | read, chat |
| Projects | every project, or chosen folders | every project |
| Modes | which permission modes it may use, and its default: `manual` (approvals come to your phone), `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`. Auto and Bypass are only for keys with every project; Bypass also needs `HANDOFF_ALLOW_BYPASS` | manual |
| Tools | `all`, `readOnly` (Read, Glob, Grep, WebSearch, WebFetch; no MCP servers) or `none` (just talk) | all |
| Defaults | model, effort, plain-text answers, answer language and length | Claude Code's |
| Alerts | also alert your phone when its tasks finish (approvals always alert) | off |
| Limits | requests a minute (30), turns at once (2), a daily budget in USD | as shown |
| Expires | never, or after a number of days | never |

**Presets** fill this in with one choice:
- **Phone shortcut:** read and chat, read-only tools, `haiku`, low effort, plain text.
- **Automation:** read, chat, approve and files, all tools, approvals to your phone.
- **Chat app:** read and chat, no tools.

A key with every scope, project, mode and tool is **full**. Any other key is **limited**: it never writes into a session it didn't start, but answers in its own copy (see section 7).

## 2. Quick start

Set `H=https://claude.example.com/api/v1` and `K=hk_…`.

```bash
# ask something; the answer comes back when it's ready
curl $H/chat -H "Authorization: Bearer $K" -d '{"prompt": "What does this project do?", "project": "shop"}'

# the next /chat continues that same session, with its context
curl $H/chat -H "Authorization: Bearer $K" -d '{"prompt": "And how do I run its tests?"}'

# just the text (handy for shortcuts)
curl $H/chat -H "Authorization: Bearer $K" -H "Accept: text/plain" -d '{"prompt": "Summarise yesterday'"'"'s commits", "plain": true}'

# every session on the computer, newest first; then pick one for /chat
curl "$H/sessions?limit=20" -H "Authorization: Bearer $K"
curl -X PUT $H/selection -H "Authorization: Bearer $K" -d '{"session": "<session id>"}'
```

`curl -d` sends no JSON content type; that's fine, the API reads JSON either way.

## 3. Sending prompts

| Endpoint | What it does |
|---|---|
| `POST /chat` | **The simple one.** Continues the selected session; with none selected, starts a new one and selects it. `"session"`: a session id, `"new"` or `"latest"` (the newest in `"project"`). If the selected session was deleted, a new one is started, with a warning |
| `PUT /selection` `{"session": id}`, `GET /selection`, `DELETE /selection` | pick the session `/chat` continues |
| `POST /sessions` | start a new session |
| `POST /sessions/{id}/messages` | send to a session (continues it) |
| `POST /sessions/{id}/ask` | **ask without a trace:** an unsaved copy answers, so the session gets nothing added and no new chat is saved. Tools default to `readOnly` (`none` allowed, `all` not) |
| `POST /sessions/{id}/interrupt`, `/stop` | stop the current step, or end the process (its queued turns are cancelled). Sessions open on the computer must be stopped there |
| `DELETE /turns/{id}` | cancel a queued turn, or interrupt the running one |

**Body fields** (only `prompt`, or a file or photo, is needed):

| Field | |
|---|---|
| `prompt` | up to 100,000 characters |
| `model`, `effort` | from `GET /models` (`opus`, `sonnet`, `haiku` or a full `claude-…` id; `low` … `max`). An effort level the model doesn't take is left out, with a warning |
| `mode` | a permission mode the key may use |
| `language`, `length` | e.g. `"Urdu"`; `brief`, `normal` or `detailed`. A short note goes at the end of the prompt, so it works everywhere |
| `plain` | `true`: the answer without Markdown, for voice and short messages |
| `fork` | `true`: answer in a copy; the original stays as it is |
| `ifBusy` | the session is mid-step: `queue` (wait, the default), `interrupt` (stop it, then send) or `fail` (`409`) |
| `ifLaptop` | the session is open in Claude Desktop or a terminal: `send` (into it, the default) or `fork` |
| `timeout` | seconds before the turn is interrupted (up to 7,200) |
| `images`, `files` | see section 5 |
| `webhook` | see section 9 |
| `wait`, `stream`, `format` | see section 4 |

**Only on new sessions, forks and one-offs** (`"save": false`), because they're set when Claude starts:

| Field | |
|---|---|
| `project` | a project key, full path or unique name. Without it, new sessions run in the key's own folder under `HANDOFF_API_DIR` (`~/Handoff chats`), never in your projects |
| `worktree` | `true` or a name: the session gets its own git worktree and branch |
| `tools` | `all`, `readOnly` or `none` (no wider than the key's) |
| `system` | extra instructions |
| `schema` | a JSON Schema: the answer comes back as structured JSON in `json` |
| `maxBudgetUsd` | a spending cap for that process |
| `save` | `false`: nothing is saved, for one-off questions; `sessionId` is `null` |

`Idempotency-Key: <anything>` on a send makes a repeat of it (a retry after a dropped connection) return the first turn instead of sending the prompt again.

## 4. Getting the answer

One prompt and its answer is a **turn**. Its `status` is `queued`, `running`, `waiting_for_approval`, `waiting_for_answer`, `done`, `error` or `interrupted`.

- **Wait** (the default): the request waits up to `wait` seconds (default 60, at most 90; Cloudflare drops responses that take over 100 s to start). It gets `200` with the finished turn, or `202` with the turn so far and `Location: /api/v1/turns/{id}`.
- **Poll:** `GET /turns/{id}?wait=60` waits until the turn finishes or its status changes (an approval needed, say).
- **Stream:** `"stream": true` (or `GET /turns/{id}/stream`) gives Server-Sent Events:

  | Event | Carries |
  |---|---|
  | `turn` | the turn when the stream starts |
  | `status` | a new status, queue position or approval |
  | `text` | the answer as it's written, piece by piece |
  | `message` | a finished block of text |
  | `tool` / `tool_result` | each step Claude takes, briefly |
  | `approval` | a request waiting for Allow/Deny |
  | `done` / `error` | the finished turn |
  | `ping` | every 15 s |

- **Plain text:** `"format": "text"` or `Accept: text/plain` returns just the answer. A failure comes back as `429` (your plan's usage limit) or `502`, with the message as text; not finished yet is `202`.

**A turn:**

```json
{ "id": "turn_…", "sessionId": "…", "status": "done",
  "text": "the final answer", "messages": ["each block of text Claude wrote"], "json": null,
  "model": "opus", "effort": "high", "delivered": "new | handoff | fork | laptop",
  "usage": { "inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0, "costUsd": 0.012 },
  "durationMs": 8123, "steps": [{ "tool": "Edit", "summary": "src/cart.js" }], "filesChanged": ["src/cart.js"],
  "pending": null, "warnings": [], "queue": null, "error": null,
  "webUrl": "https://claude.example.com/#/s/…" }
```

- **`error.code`** values from Claude itself:
  - `claude_signed_out`: Claude Code on the computer isn't signed in. Run `claude setup-token` and put the token in `.env` as `CLAUDE_CODE_OAUTH_TOKEN`.
  - `claude_limit`: your plan's usage limit was reached; the message says when it resets.
  - `claude_error`: anything else Claude reported.
- **`webUrl`** opens the chat in the web app. It is `null` without the web app, or for unsaved turns.
- **`GET /turns`** lists the key's recent turns, including notes from before a restart. A turn from before a restart answers `"status": "lost"`, with where to read its session's messages.

## 5. Photos, files and @mentions

Attach with JSON:

```json
{ "prompt": "What's wrong in @error.log?",
  "images": [{ "media_type": "image/png", "data": "<base64>" }],
  "files": [{ "name": "error.log", "data": "<base64>" }] }
```

or as a multipart upload: `curl -F prompt="Summarise this" -F file=@report.pdf $H/chat -H "Authorization: Bearer $K"`. The other fields go in as text, or all of them as JSON in a `json` field.

- **Photos** (JPEG, PNG, GIF, WebP, up to 5 MB) go to Claude as images.
- **Small text files** (under 100 KB) go straight into the prompt.
- **Other files** are saved in the session's folder under `.handoff-uploads/` (ignored by git, cleared after a week) and named in the prompt, for Claude's Read tool, which reads PDFs, code, notebooks and more. With `"tools": "none"`, a PDF goes in as a document instead.
- **Limits:** up to 10 files, each up to `HANDOFF_API_UPLOAD_MB` (20 MB), 50 MB in all. Unknown binary files are refused.
- **`@name`** in the prompt points at an attached file. `@src/app.js` (a project file) is read by Claude Code. An @path **outside the session's folder** is refused, because Claude Code would read it straight into the prompt.

Files Claude made or changed, with the `files` permission (and `HANDOFF_FILE_BROWSER` on):
- `GET /sessions/{id}/files?path=`, `/file?path=`, `/download?path=` and `/find?q=`;
- `/changes` and `/diff?path=`;
- `GET /folders` (keys with every project) and `POST /folders` `{"parent", "name", "git"}`.

## 6. Sessions and reading

| Endpoint | |
|---|---|
| `GET /me` | this key: scopes, limits, defaults, today's use, webhook secret, selected session |
| `GET /models` | models and their effort levels, as the installed Claude Code reports them (the OpenAI list shape) |
| `GET /projects` | project folders the key can see |
| `GET /sessions?project=&q=&live=true&via=api&limit=50&before=` | every session across projects, newest first, paged with `next`. `status`: `laptop` (open in Desktop or a terminal), `running`, `waiting`, `idle`, `saved` |
| `GET /sessions/{id}` | one session, with waiting approvals or questions and an activity summary |
| `GET /sessions/{id}/messages?format=chat\|events&limit=100&before=` | the conversation, newest last. `chat`: `[{role, text, ts}]`, long answers whole; `events`: tool calls too. Page backwards with `before` |
| `GET /sessions/{id}/activity` | to-dos, plan, files changed, commands, sub-agents |
| `GET /search?q=`, `GET /sessions/{id}/search?q=` | full-text search |
| `GET /usage?days=30` | turns, tokens and cost per day |

## 7. Approvals, laptop sessions and limited keys

- **Approvals:** in mode `manual`, when Claude wants to run a command or change a file, the turn waits (`waiting_for_approval`). The request reaches your phone as usual (push or WhatsApp, with Allow and Deny), naming the key. A key with the `approve` permission can also answer: `GET /approvals`, then `POST /approvals/{id}` `{"allow": true}`. `alwaysMode` switches the session to another mode the key may use. Unanswered requests are denied after `HANDOFF_PERMISSION_TIMEOUT_MINUTES`.
- **Sessions open on the computer** (Claude Desktop or a terminal):
  - the prompt goes into the open session, as the web app does, and the answer is read from its transcript;
  - model, effort, mode and tools stay as they are there, with a warning;
  - its own approvals stay on the computer;
  - `POST /sessions/{id}/answer` `{"picks": [2]}` answers a question it asks.
- **Limited keys** never write into a session they didn't start, or into one open on the computer. They answer in their own copy of it, and keep using that copy next time, so the conversation goes on there.
- **The web app takes sessions back:** when you send from the web app into an idle process an API key started with limits, it restarts with normal settings first.

## 8. Compare models

```bash
curl $H/compare -H "Authorization: Bearer $K" -d '{"prompt": "How should I cache this?", "models": ["opus", {"model": "haiku", "effort": "low"}]}'
```

- **Models:** 2 or 3. They answer side by side, with time, tokens and cost.
- **Nothing is saved:** each answers in its own unsaved copy, with `"session"`, or with no session at all.
- **Tools:** `none` by default; `readOnly` is allowed.
- **Running:** they run at the same time while there's room, otherwise one after another.
- **Waiting:** like a turn (`202`, then `GET /compare/{id}`), or `"stream": true` for every model's events, each tagged with its `model`.

## 9. Webhooks

Add `"webhook": "https://your.server/hook"` to a send. Handoff POSTs `{ "event", "sentAt", "turn" }` there when the turn needs an approval and when it ends:
- **Events:** `turn.waiting_for_approval`, `turn.done`, `turn.error`, `turn.interrupted`.
- **Signature:** `X-Handoff-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`, keyed with the key's webhook secret (`GET /me`, or shown when the key is made).
- **Delivery:** HTTPS only, redirects aren't followed, 10 s per try, 3 retries (after 5 s, 30 s and 2 min).
- **Private addresses are refused:** this computer, private networks and similar.

```python
import hmac, hashlib, time
def valid(secret, header, body: bytes):
    parts = dict(p.split("=", 1) for p in header.split(","))
    mac = hmac.new(secret.encode(), f"{parts['t']}.".encode() + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(mac, parts["v1"]) and abs(time.time() - int(parts["t"])) < 300
```

```js
import crypto from 'node:crypto';
const valid = (secret, header, body) => {
  const p = Object.fromEntries(header.split(',').map(x => x.split('=')));
  const mac = crypto.createHmac('sha256', secret).update(`${p.t}.${body}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(p.v1)) && Math.abs(Date.now() / 1000 - p.t) < 300;
};
```

## 10. OpenAI-compatible endpoint

`POST /chat/completions`, with `GET /models`. Point any OpenAI client at base URL `https://claude.example.com/api/v1` with your Handoff key:

```python
from openai import OpenAI
client = OpenAI(base_url="https://claude.example.com/api/v1", api_key="hk_…")
r = client.chat.completions.create(model="sonnet", messages=[{"role": "user", "content": "Explain this repo"}])
print(r.choices[0].message.content)
```

- **Conversations:** a chat app resends the whole history each time. Handoff recognises its own last reply and continues that session with just the new message. An edited or regenerated chat starts a new session, with the earlier messages in its first prompt.
- **Picking a session or project yourself:** the `X-Handoff-Session: <id>|new` and `X-Handoff-Project` headers, or `metadata.handoff_session` and `metadata.handoff_project`. `X-Handoff-Language` and `X-Handoff-Length` work too.
- **What's taken:**
  - `model` (Claude Code's models only);
  - `reasoning_effort` (`low` … `max`);
  - `response_format` with `json_schema`;
  - images as `data:` URLs;
  - `file` parts;
  - system messages (on a new session).
- **What's refused, with a clear error:** function calling (`tools`), `n > 1`, audio, and image addresses.
- **Streaming:**
  - chunks, then `[DONE]`;
  - Claude's steps arrive as `reasoning_content`, which apps that show "thinking" display;
  - approvals wait for your phone, and the stream says so.
- **Long answers without streaming** keep the connection alive with spaces before the JSON.
- **Repeats:** a request repeated while it's still being answered (an SDK retry) joins that answer.
- **Open WebUI** (or LibreChat and the like): add an OpenAI connection with the base URL above and a **Chat app** key. Side requests such as titles and tags start short sessions in that key's folder, never in your projects; point them at a quick model (e.g. `haiku`) in the app's settings, or turn them off.

## 11. Ready-made clients

In [`clients/`](../clients). One file each, no packages. Download straight from GitHub (`https://raw.githubusercontent.com/mmehran/handoff/main/clients/<file>`):

- **Python** ([`handoff.py`](../clients/handoff.py), standard library only):
  ```python
  from handoff import Handoff, file
  h = Handoff("https://claude.example.com", "hk_…")          # or HANDOFF_URL / HANDOFF_KEY
  print(h.chat("What changed today?", project="shop")["text"])
  for ev in h.stream("/chat", {"prompt": "Explain the cart"}):
      if ev["event"] == "text": print(ev["data"]["text"], end="", flush=True)
  ```
- **JavaScript** ([`handoff.mjs`](../clients/handoff.mjs), Node 20+ and browsers): `new Handoff(url, key)`, with `chat()`, `send()`, `ask()`, `compare()`, `stream()`, `sessions()`, `select()`, `turns()`, `approve()` and more.
- **A `handoff` command** ([`handoff-cli.mjs`](../clients/handoff-cli.mjs)) for another computer's terminal. Set `HANDOFF_URL` and `HANDOFF_KEY`, or write `{"url": "…", "key": "hk_…"}` to `~/.handoff.json`:
  ```bash
  node handoff-cli.mjs ask "why does the build fail?" --project shop --stream
  node handoff-cli.mjs ask "summarise this" --file report.pdf --session new
  node handoff-cli.mjs sessions --project shop
  node handoff-cli.mjs select <session id>
  node handoff-cli.mjs approve <approval id> yes
  node handoff-cli.mjs compare "Which is faster?" opus haiku
  ```

## 12. Phone shortcuts

Make a **Phone shortcut** key first (quick model, read-only, plain text).

- **iPhone (Shortcuts app):**
  1. **Ask for Input** (Text), or **Dictate Text**.
  2. **Get Contents of URL**: `https://claude.example.com/api/v1/chat`, method POST, headers `Authorization: Bearer hk_…` and `Accept: text/plain`, request body JSON with `prompt` set to the input.
  3. **Show Result**, or **Speak Text**.

  Name it "Ask my computer", and Siri runs it.
- **Android (HTTP Shortcuts app):** a shortcut with method POST, URL `…/api/v1/chat`, the same two headers, body `{"prompt": "{prompt}"}` with a text variable `prompt`, and "show response" as the response handling.

Answers that take longer than about 90 seconds come back as "Still working…": ask again with `GET /api/v1/turns/<id>?format=text`, or keep phone questions short.

## 13. Limits and errors

Errors are `{"error": {"code": "…", "message": "…"}}`:

| Status | Codes |
|---|---|
| `400` | `invalid_request`, `invalid_json`, `empty_prompt`, `unknown_model`, `start_only`, `mention_outside`, `needs_tools`, `invalid_webhook` |
| `401` | `unauthorized` (missing, wrong, revoked or expired key) |
| `402` | `budget_exceeded` (the key's daily budget; starts again at midnight, the computer's time) |
| `403` | `forbidden_scope`, `mode_not_allowed`, `tools_not_allowed` |
| `404` | `not_found`, `session_not_found`, `project_not_found`, `turn_not_found`, `api_off`, `files_off`, `git_off` |
| `409` | `session_busy` (with `"ifBusy": "fail"`), `laptop_session`, `ambiguous_project` |
| `413` / `415` | `too_large`, `unsupported_file` |
| `429` | `rate_limited`, `too_many_turns`, `too_many_runs` (all with `Retry-After`), `too_many_wrong_keys` (5 wrong keys from one address in 15 minutes) |
| `501` | this Claude Code is too old for a setting (update it) |

**Processes:**
- The API may use all but one of `HANDOFF_MAX_RUNS`, so the web app always has room.
- Idle API processes stop after `HANDOFF_API_IDLE_SECONDS` (60), and the oldest idle one makes room first. The next prompt resumes the session.

**Things to know:**
- **When the computer is asleep or off,** Cloudflare answers `502`/`530`, and `GET /api/v1/health` fails.
- **A restart of Handoff** (an update, for example) stops running answers, as for the web app.
- **Cost** is Claude Code's estimate per turn. On a subscription it isn't a bill.
- **Cloudflare Access:** if you put it in front of your hostname, add a bypass policy for `/api/v1/*`, so programs with a Handoff key get through.
- **CORS** is off: only websites listed in `HANDOFF_API_CORS_ORIGINS` can call the API from a browser.
- **The audit log** gets every call, with the key's name; the web app shows each key's recent calls (menu → API access → Activity).
