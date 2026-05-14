# stacktree-mcp

MCP server for [stacktr.ee](https://stacktr.ee). Publish HTML artifacts from any MCP client (Claude Desktop, Claude Code, Cursor, Continue, etc).

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

| Tool             | What it does                                                  |
| ---------------- | ------------------------------------------------------------- |
| `publish_html`   | Publish HTML; returns `{ url, id, expires_at, ... }`.         |
| `update_site`    | Replace HTML of an existing site in place; URL is preserved.  |
| `delete_site`    | Hard delete a site.                                           |
| `set_password`   | Add or clear a basic-auth password.                           |
| `set_expiry`     | Set hours-from-now expiry, or `null` for never.               |
| `set_agentation` | Toggle the on-page Agentation feedback toolbar.               |
| `list_sites`     | List sites owned by this API key.                             |

## Privacy defaults

Every site gets an unguessable `https://stacktr.ee/p/{token}/` URL. Pass `public_slug` to opt into `https://{slug}.stacktr.ee/`.

`pii_check` defaults to `warn` — common secrets and PII shapes (emails, SSNs, credit cards, OpenAI/GitHub/Stripe API key prefixes) are flagged in the response. Pass `block` to refuse uploads that match.
