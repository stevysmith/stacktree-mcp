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

## Tools

| Tool               | What it does                                                                |
| ------------------ | --------------------------------------------------------------------------- |
| `publish_html`     | Publish HTML; returns `{ url, id, expires_at, ... }`. Pass `client` to file it under a client space. |
| `update_site`      | Replace the HTML of an existing site in place; URL is preserved.            |
| `get_site`         | Read a site's current HTML source — edit it, then `update_site`.            |
| `set_password`     | Add or clear a passcode gate. Paid plans only.                              |
| `set_expiry`       | Set hours-from-now expiry, or `null` for never. Clamped to the plan ceiling.|
| `set_email_gate`   | Restrict viewers to an email domain (one-time magic-link verify). Paid plans only. |
| `set_agentation`   | Toggle the on-page Agentation feedback toolbar.                             |
| `list_sites`       | List sites owned by this API key. Paged (`has_more` + cursor); filter with `client`. |
| `delete_site`      | Hard delete a site.                                                         |
| `link_wallet`      | Link your wallet so pages you publish are owned by your account.            |
| `list_feedback`    | Read viewer annotations left via the Agentation toolbar; unresolved first.  |
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

A key on the free plan publishes **3 pages in total**, and each one **expires 7 days** after it is published. The count is lifetime, not concurrent: deleting a page or letting it expire does not give the slot back. `expires_in_hours: "never"` is clamped to the 7-day ceiling rather than refused, so always read `expires_at` off the response.

Passcodes (`set_password`), email gates (`set_email_gate`) and viewer numbers are on paid plans. Hitting a ceiling returns HTTP 402 with a stable `plan_*` code in `error`:

| Code | Means |
| --- | --- |
| `plan_lifetime_limit_exceeded` | All 3 free pages used. Deleting one does not help. |
| `plan_site_limit_exceeded` | Active-page cap reached. |
| `plan_password_not_available` | Passcodes are not on this plan. |
| `plan_viewer_gate_not_available` | Email gates are not on this plan. |
| `plan_domain_not_available` | Custom domains are not on this plan. |

`GET /me` returns the calling key's own `limits` object. Read caps from there rather than hard-coding them. Current plans and prices: <https://stacktr.ee/pricing.md>.
