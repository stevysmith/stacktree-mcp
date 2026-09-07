# stacktree-mcp

MCP server for [stacktr.ee](https://stacktr.ee). Publish HTML artifacts from any MCP client (Claude Desktop, Claude Code, Cursor, Continue, etc).

## Set up with an agent

If you have a coding agent open, hand it this line and it does the rest —
installs, verifies the connection, and learns the tool surface:

```
Fetch and follow the setup instructions at https://stacktr.ee/prompt.md
```

Works in any agent that can fetch a URL. The instructions are plain Markdown;
read them first if you like.

## Install

Add to your MCP client config:

```json
{
  "mcpServers": {
    "stacktree": {
      "command": "npx",
      "args": ["-y", "stacktree-mcp"],
      "env": { "STACKTREE_API_KEY": "stk_live_..." }
    }
  }
}
```

Generate an API key at <https://app.stacktr.ee>.

## You may not need this package

This is the **stdio** bridge, for clients that cannot speak streamable HTTP.
If yours can, connect straight to the hosted server at
`https://api.stacktr.ee/mcp` — it exposes the same 25 tools and takes the same
key:

```bash
curl -sS -X POST https://api.stacktr.ee/mcp \
  -H "Authorization: Bearer $STACKTREE_API_KEY" \
  -H 'accept: application/json, text/event-stream' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

No browser and no OAuth flow is required to do that: an `stk_live_` key is a
valid credential on the MCP endpoint, exactly as it is on the REST API. OAuth
2.1 with Dynamic Client Registration is also accepted, for connectors acting on
behalf of a signed-in human; session cookies are refused. Send one credential.

No key, and no human to ask? `POST https://api.stacktr.ee/provision` buys one
over x402. A human nearby but no browser? `POST
https://api.stacktr.ee/api-keys/device-code`, print the returned
`verification_url_complete` for them, and poll
`/api-keys/device-code/poll` until it returns the key (RFC 8628).

## Tools (25)

| Tool               | What it does                                                                |
| ------------------ | --------------------------------------------------------------------------- |
| `publish_html`     | Publish HTML; returns `{ url, id, expires_at, ... }`. Pass `client` to file it under a client space. |
| `update_site`      | Replace the HTML of an existing site in place; URL is preserved.            |
| `get_site`         | Read a site's current HTML source — edit it, then `update_site`.            |
| `set_password`     | Add or clear a passcode gate. Works on every plan.                          |
| `set_expiry`       | Set hours-from-now expiry, or `null` for never. Clamped to the plan ceiling.|
| `set_email_gate`   | Restrict viewers to an email domain (one-time magic-link verify). Paid plans only. |
| `set_agentation`   | Toggle the on-page Agentation feedback toolbar.                             |
| `list_sites`       | List sites owned by this API key. Paged (`has_more` + cursor); filter with `client`. |
| `delete_site`      | Take a page down. The link dies at once; the content is kept 30 days, then destroyed. |
| `restore_site`     | Put a deleted or expired page back at the same URL, inside those 30 days.   |
| `claim_site`       | Adopt a page published without an account, using its `claim_token`. Same URL; a claim counts as a publish. |
| `get_content`      | Read a page back as `html` (exact stored source, editable) or `text` (stripped, cheap to read). |
| `get_me`           | This key's account, plan, counts and enforced `limits`. Read limits from here, never from a description. |
| `link_wallet`      | Link your wallet so pages you publish are owned by your account.            |
| `list_feedback`    | Read viewer annotations left via the Agentation toolbar; unresolved first.  |
| `create_share_link`| Mint a link addressed to one person — every open through it is attributed to that name. |
| `list_share_links` | The links on a page, with attributed opens and when each was last opened.   |
| `revoke_share_link`| Kill one link; the page and every other link keep working.                  |
| `resolve_feedback` | Mark a feedback item addressed, with an optional note.                      |
| `set_client`       | File a page under a client space by name or slug (auto-created), or `null` to detach. |
| `list_client_spaces` | The client spaces on the account: page counts, bound hostname, portal state. |
| `create_client_space` | Create a space up front. Rarely needed — publishing with `client` creates one. |
| `update_client_space` | Rename, archive, or set the space-wide viewer gate every page under it inherits. |
| `delete_client_space` | Remove a space. Its pages detach and keep their URLs.                  |
| `get_design_guide` | The house design guide — read it before generating or restyling a page.     |

## Linking a wallet

If your agent pays for publishes from its own wallet (x402 / MPP), link that wallet to your Stacktree account so every page it publishes — past and future — is owned there:

1. Your human generates a link code at <https://app.stacktr.ee/wallets>.
2. `link_wallet({ code })` → returns the exact message to sign.
3. Sign it with your wallet (`personal_sign`).
4. `link_wallet({ code, wallet, signature })` → links the wallet and adopts the pages it already published.

## Reading feedback

Turn on the on-page toolbar with `set_agentation` and viewers can annotate the page; their comments are stored with the site. `list_feedback` returns them, unresolved first (comment, annotated element, selected text, intent, severity). Fix the page in place with `update_site` (same URL), then `resolve_feedback` to mark each item addressed, with an optional note.

## Privacy defaults

Every site gets an unguessable `https://stacktr.ee/p/{token}/` URL. Pass `public_slug` to opt into `https://{slug}.stacktr.ee/`.

`pii_check` defaults to `block` — uploads matching common secrets and PII shapes (emails, SSNs, credit cards, OpenAI/GitHub/Stripe API-key prefixes) are refused. Pass `warn` to publish anyway (matches are flagged in the response), or `off` to skip the scan.

## What the free plan gives you

A key on the free plan publishes **3 pages in total**, and each one **expires 7 days** after it is published. The count is lifetime, not concurrent: deleting a page or letting it expire does not give the slot back.

`expires_in_hours: "never"` is **refused** on a plan that caps page lifetime, not quietly shortened: `409 expiry_clamped`, nothing published, and the body carries the date the page would have got. Pass `accept_clamp: true` to take the ceiling, or tell the user the plan cannot make the link permanent. A *number* longer than the ceiling is shortened rather than refused, with `expiry_clamped: true` in the response. Either way, read `expires_at_iso` off the response and quote that, never the value you asked for.

Passcodes (`set_password`) work on every plan, free included. Email gates (`set_email_gate`) and viewer numbers are on paid plans. Hitting a ceiling returns HTTP 402 with a stable `plan_*` code in `error`:

| Code | Means |
| --- | --- |
| `plan_lifetime_limit_exceeded` | All 3 free pages used. Deleting one does not help. |
| `plan_site_limit_exceeded` | Active-page cap reached. |
| `plan_password_not_available` | Passcodes are not on this plan (they are on Free; a plan can still be without them). |
| `plan_viewer_gate_not_available` | Email gates are not on this plan. |
| `plan_domain_not_available` | Custom domains are not on this plan. |

`GET /me` — or the `get_me` tool — returns the calling key's own `limits` object. Read caps from there rather than hard-coding them. Current plans and prices: <https://stacktr.ee/pricing.md>.
