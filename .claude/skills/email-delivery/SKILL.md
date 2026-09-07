---
name: email-delivery
description: "Send email to the CEO from agents — digest delivery, alerts, reports. Use whenever a task needs to email the CEO. Handles the Gmail SMTP setup protocol when credentials are missing."
---

# Email Delivery

All agent email goes through ONE implementation on every platform: `ws email`
(`cli/util/smtp.js` — Gmail SMTP, app password from env). The recipient is always
`OWNER_EMAIL` (env var — mail identity has no code default; see `.env.example`)
unless the CEO says otherwise.

## Sending

```
node C:\Users\olanh\sources\workspace\cli\ws.js email --subject "Subject line" --body-path C:\path\to\body.md
# container / Linux:
node ~/sources/workspace/cli/ws.js email --subject "Subject line" --body-path /path/to/body.md
```

- `--body-path` takes a markdown file, sent as plain text (readable in Gmail).
  Optional `--html` sends it as HTML; `--to` overrides the recipient;
  `--in-reply-to <message-id>` threads onto an existing conversation.
- Sends From the agent +alias with Reply-To back to it, and always carries the
  `X-Workspace-Agent` header so the inbox poller never mistakes agent mail for a request.
- Reads `GMAIL_APP_PASSWORD` from the environment. It never appears in code, logs,
  or fallback files.
- Exit codes: 2 = password or mail identity (`OWNER_EMAIL`/`AGENT_EMAIL`) not set, 3 = body file missing, 1 = send failed.

## When credentials are missing

Check SETUP.md first ("Email delivery (Gmail app password)" row). If ❌, follow the SETUP.md protocol — don't fail silently, don't fake it:

1. Tell the CEO: Gmail app passwords require 2-Step Verification on the Google account.
2. Walk the CEO through it: myaccount.google.com → Security → 2-Step Verification (enable if needed) → App passwords → create one named "claude-agents" → copy the 16-character password.
3. Have them set it (or set it for them if they paste it — then tell them to delete it from chat history):
   `[Environment]::SetEnvironmentVariable("GMAIL_APP_PASSWORD", "<the password>", "User")`
   (on the VM: add it to `~/agent/workspace/.env` and recreate the container)
4. Verify with a real test send via `ws email`. Only after a successful send, flip the SETUP.md row to ✅ and append to the setup log.

## Failure handling

SMTP failure = log `failed` with the error one-liner via `node workspace/cli/ws.js log` (or `node cli\ws.js log` directly) and make sure the content is archived on disk. Never retry more than twice in one run. Never write the password anywhere.

## Capture

Every successful send is captured into the central message table (kind `email-out`) automatically inside `cli/util/smtp.js` — non-fatal, no per-agent action needed.
