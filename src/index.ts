#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const API_URL = process.env.STACKTREE_API_URL || 'https://api.stacktr.ee';
const API_KEY = process.env.STACKTREE_API_KEY;

if (!API_KEY) {
  console.error('STACKTREE_API_KEY env var is required');
  process.exit(1);
}

// ----- tool schemas --------------------------------------------------------

// Privacy-first MCP defaults. Agents act autonomously; defaults should be
// safer than the raw API. Override per-call when needed.
//
// Expiry is PLAN-AWARE since 2026-08-14: an omitted expires_in_hours sends
// nothing, and the worker decides — free clamps to its 168h ceiling, paid
// plans get permanence. Tool descriptions below state facts without selling —
// MCP tool output is not a marketing surface.
const MCP_DEFAULT_PII_MODE = 'block' as const;

const PublishHtml = z.object({
  content: z.string().describe('Full HTML to publish.'),
  filename: z.string().default('index.html').describe('Logical filename; defaults to index.html.'),
  password: z.string().optional().describe('Optional passcode gate on serve. Works on every plan, free keys included.'),
  expires_in_hours: z.union([z.number(), z.literal('never')]).optional()
    .describe('Lifetime in hours, or "never". Default when omitted: permanent on paid plans, 7 days on the free plan (its ceiling). A NUMBER over the ceiling is clamped to it and the response says so (expiry_clamped: true). "never" on a capped plan is REFUSED (409 expiry_clamped, nothing published) so a 7-day page can never be reported as permanent: pass accept_clamp to take the ceiling. Read expires_at_iso and ttl_seconds in the response for what the page actually got.'),
  accept_clamp: z.boolean().optional()
    .describe('Only needed when you asked for "never" on a plan that caps page lifetime. Set true to accept the ceiling and publish anyway, instead of being refused.'),
  idempotency_key: z.string().optional()
    .describe('Any unique string identifying THIS publish (a UUID is ideal). Retrying with the same key and the same content returns the original page instead of creating a second one, and spends no extra page slot. Change the key when the content changes.'),
  burn_after_read: z.boolean().optional().describe('Auto-delete after first view. Default: false.'),
  agentation: z.boolean().optional().describe('Inject the Agentation feedback toolbar on serve. Default: false.'),
  public_slug: z.string().optional().describe('Opt into a memorable {slug}.stacktr.ee URL. Default: omit (unlisted).'),
  pii_check: z.enum(['off', 'warn', 'block']).optional().describe('PII pre-flight scan mode. MCP default: block.'),
  client: z.string().optional().describe('Client space to file this page under, by name or slug (e.g. "Acme Co"). Auto-created if it does not exist — no setup call needed. When the user names a client, customer, or project the page is FOR, pass it here. Reuse the exact spelling from list_client_spaces when the client already exists. If the space has its own address (hostname), the response also carries client_url — the link on the client’s own domain; prefer handing that one to the user.'),
  client_path: z.string().optional().describe('Optional stable path for this page within the client space (e.g. "june-report"). Defaults from the page title.'),
});

const UpdateSite = z.object({
  id_or_slug: z.string().describe('Site id, slug, or unlisted token.'),
  content: z.string().describe('New HTML content.'),
  filename: z.string().default('index.html'),
  pii_check: z.enum(['off', 'warn', 'block']).optional().describe('PII pre-flight scan mode. MCP default: block.'),
});

const DeleteSite = z.object({
  id_or_slug: z.string(),
});

// The undo half of delete_site (worker migration 0047). This package is what
// installed agents actually run, so a verb missing here is a verb the agent
// cannot reach: an MCP client's only transport is the tool list, and a 409
// body naming "POST /sites/{id}/restore" is a door it cannot open. Mirrors the
// hosted worker's restore_site tool so the two surfaces cannot drift.
const RestoreSite = z.object({
  id_or_slug: z.string().describe('Site id, slug, or unlisted token. All three still resolve while the page is down.'),
});

// The three parity tools (2026-09-01). The hosted worker and this package are
// the same tool surface by contract — test/mcpTools.test.ts fails the build if
// they diverge — so a tool added there is added here in the same change.
const ClaimSite = z.object({
  id_or_slug: z.string().describe('The site id from the anonymous publish response.'),
  claim_token: z.string().describe('The secret claim_token from that same response. Sensitive: anyone holding it can adopt the page.'),
});

const GetContent = z.object({
  id_or_slug: z.string().describe('Site id, slug, or unlisted token.'),
  format: z.enum(['html', 'text']).optional()
    .describe('html (default) = the exact stored source, editable. text = stripped plain text, cheap to read, NOT editable.'),
});

const GetMe = z.object({});

const SetPassword = z.object({
  id_or_slug: z.string(),
  password: z.string().nullable().describe('null clears the passcode. Works on every plan; clearing one always works too.'),
});

const SetExpiry = z.object({
  id_or_slug: z.string(),
  expires_in_hours: z.number().nullable().describe('null = never, on a plan that allows it. A number over the plan ceiling is clamped to it (free: 168 hours) and the response says so. null on a capped plan is REFUSED (409 expiry_clamped, nothing changed) rather than quietly becoming 7 days; pass accept_clamp to take the ceiling. Quote expires_at_iso from the response, not what you asked for.'),
  accept_clamp: z.boolean().optional().describe('Accept the plan ceiling instead of being refused when asking for a page that never expires.'),
});

const SetAgentation = z.object({
  id_or_slug: z.string(),
  enabled: z.boolean(),
});

const SetEmailGate = z.object({
  id_or_slug: z.string(),
  domain: z.string().nullable().describe('Email domain (e.g. "openai.com"); strict-equal, no subdomain match. null clears the gate. Setting one needs a paid plan; clearing one always works.'),
});

const ListSites = z.object({
  client: z.string().optional().describe('Only sites filed under this client space (name or slug).'),
  limit: z.number().optional().describe('Sites per page, 1-500. Defaults to 200.'),
  before: z.number().optional().describe('Cursor: pass next_before from the previous response. Send together with before_id.'),
  before_id: z.string().optional().describe('Cursor: pass next_before_id from the previous response. Send together with before.'),
});

const ListClientSpaces = z.object({});

const GetDesignGuide = z.object({});

const SetClient = z.object({
  id_or_slug: z.string().describe('Site id, slug, or unlisted token.'),
  client: z.string().nullable().describe('Client space name or slug. Pass null to detach.'),
});

// Client-space management. The spec names three tools create/update/
// archive_client_space, but archive is a FIELD on PATCH /spaces/:idOrSlug, not
// a route of its own: a dedicated archive tool would be a second name over the
// same endpoint (and one PATCH can rename and archive together) while leaving
// DELETE undeclared. Archive rides update_client_space as `archived`, and the
// archive-vs-delete choice is spelled out in both descriptions instead.
const CreateClientSpace = z.object({
  name: z.string().describe('Display name, e.g. "Acme Co". Casing is kept for display; identity is case-insensitive.'),
});

const UpdateClientSpace = z.object({
  id_or_slug: z.string().describe('Space id or slug from list_client_spaces. Not the display name.'),
  name: z.string().optional().describe('New display name. The slug stays as it is.'),
  archived: z.boolean().optional().describe('true archives (everything keeps serving, the plan slot is freed), false unarchives.'),
  password: z.string().nullable().optional().describe('A NEW passcode viewers enter to open any page in this space; null removes the gate.'),
  allowed_email_domain: z.string().nullable().optional().describe('Email domain (e.g. "acme.com") whose owners may open any page in this space; strict-equal, no subdomain match. null clears the gate.'),
});

const DeleteClientSpace = z.object({
  id_or_slug: z.string().describe('Space id or slug from list_client_spaces. Not the display name.'),
});

const GetSite = z.object({
  id_or_slug: z.string().describe('Site id, slug, or unlisted token.'),
});

const LinkWallet = z.object({
  code: z.string().describe('The LINK-XXXX code your human generated at stacktr.ee/wallets.'),
  wallet: z.string().optional().describe('Your wallet address (0x…). Omit on the first call to get the message to sign.'),
  signature: z.string().optional().describe('personal_sign signature of the returned message. Omit on the first call.'),
});

const CreateShareLink = z.object({
  id_or_slug: z.string(),
  label: z.string().describe('Who this link is for, e.g. "Megan Hanning". Every open through it is attributed to this name.'),
  expires_in_hours: z.number().nullable().optional().describe('Link lifetime. Omit for no link-level expiry.'),
  max_uses: z.number().nullable().optional().describe('Cap on uses. Omit for unlimited.'),
});

const ListShareLinks = z.object({
  id_or_slug: z.string(),
});

const RevokeShareLink = z.object({
  share_link_id: z.string().describe('The `id` from create_share_link or list_share_links.'),
});

const ListFeedback = z.object({
  id_or_slug: z.string().describe('Site id, slug, or unlisted token.'),
});

const ResolveFeedback = z.object({
  feedback_id: z.string().describe('Feedback item id from list_feedback.'),
  note: z.string().optional().describe('What was changed to address it (optional).'),
});

// ----- tool implementations ------------------------------------------------

async function publishHtml(args: z.infer<typeof PublishHtml>) {
  const fd = new FormData();
  const blob = new Blob([args.content], { type: 'text/html' });
  fd.append('file', blob, args.filename);
  if (args.password) fd.append('password', args.password);
  // Expiry — when the caller omits it, send NOTHING and let the worker's
  // plan-aware default decide: free clamps to 7 days (identical to the old
  // always-168 default here), paid plans get permanence. The unconditional
  // append meant a PAYING user's MCP publishes kept dying weekly.
  if (args.expires_in_hours !== undefined) {
    fd.append('expires_in_hours', String(args.expires_in_hours));
  }
  if (args.burn_after_read) fd.append('burn_after_read', 'true');
  if (args.agentation) fd.append('agentation', 'true');
  if (args.public_slug) fd.append('public_slug', args.public_slug);
  if (args.client) fd.append('client', args.client);
  if (args.client_path) fd.append('client_path', args.client_path);
  // PII — apply MCP-tighter 'block' default when the caller omits it.
  fd.append('pii_check', args.pii_check ?? MCP_DEFAULT_PII_MODE);
  // Forwarded only when the caller set them. Defaulting accept_clamp would put
  // the silent clamp back one layer up, and minting an idempotency key here
  // would key it to a value the caller cannot reproduce on its retry.
  if (args.accept_clamp === true) fd.append('accept_clamp', 'true');
  const idem = args.idempotency_key?.trim();
  return apiCall('POST', '/sites', {
    body: fd,
    ...(idem ? { headers: { 'idempotency-key': idem } } : {}),
  });
}

async function updateSite(args: z.infer<typeof UpdateSite>) {
  const fd = new FormData();
  const blob = new Blob([args.content], { type: 'text/html' });
  fd.append('file', blob, args.filename);
  // PII, same stricter default as publish_html: updates are publishes too.
  fd.append('pii_check', args.pii_check ?? MCP_DEFAULT_PII_MODE);
  return apiCall('PUT', `/sites/${encodeURIComponent(args.id_or_slug)}`, { body: fd });
}

async function deleteSite(args: z.infer<typeof DeleteSite>) {
  return apiCall('DELETE', `/sites/${encodeURIComponent(args.id_or_slug)}`);
}

async function restoreSite(args: z.infer<typeof RestoreSite>) {
  return apiCall('POST', `/sites/${encodeURIComponent(args.id_or_slug)}/restore`);
}

async function claimSite(args: z.infer<typeof ClaimSite>) {
  return apiCall('POST', `/sites/${encodeURIComponent(args.id_or_slug)}/claim`, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ claim_token: args.claim_token }),
  });
}

async function getMe() {
  return apiCall('GET', '/me');
}

async function setPassword(args: z.infer<typeof SetPassword>) {
  return apiCall('PATCH', `/sites/${encodeURIComponent(args.id_or_slug)}`, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: args.password }),
  });
}

async function setExpiry(args: z.infer<typeof SetExpiry>) {
  return apiCall('PATCH', `/sites/${encodeURIComponent(args.id_or_slug)}`, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expires_in_hours: args.expires_in_hours,
      ...(args.accept_clamp === true ? { accept_clamp: true } : {}),
    }),
  });
}

async function setAgentation(args: z.infer<typeof SetAgentation>) {
  return apiCall('PATCH', `/sites/${encodeURIComponent(args.id_or_slug)}`, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentation: args.enabled }),
  });
}

async function setEmailGate(args: z.infer<typeof SetEmailGate>) {
  return apiCall('PATCH', `/sites/${encodeURIComponent(args.id_or_slug)}`, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ allowed_email_domain: args.domain }),
  });
}

async function listSites(args: z.infer<typeof ListSites>) {
  const params = new URLSearchParams();
  if (args.client) params.set('client', args.client);
  if (args.limit !== undefined) params.set('limit', String(args.limit));
  if (args.before !== undefined) params.set('before', String(args.before));
  if (args.before_id) params.set('before_id', args.before_id);
  const q = params.toString();
  return apiCall('GET', `/sites${q ? `?${q}` : ''}`);
}

async function listClientSpaces() {
  return apiCall('GET', '/spaces');
}

async function getDesignGuide() {
  return apiCall('GET', '/design-guide');
}

async function createClientSpace(args: z.infer<typeof CreateClientSpace>) {
  return apiCall('POST', '/spaces', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: args.name }),
  });
}

async function updateClientSpace(args: z.infer<typeof UpdateClientSpace>) {
  // Forward only the keys the caller sent: PATCH /spaces reads a PRESENT key
  // as an instruction, and on the two gate fields null MEANS "remove the
  // gate", so nulls must survive the round trip.
  const body: Record<string, unknown> = {};
  for (const k of ['name', 'archived', 'password', 'allowed_email_domain'] as const) {
    if (args[k] !== undefined) body[k] = args[k];
  }
  return apiCall('PATCH', `/spaces/${encodeURIComponent(args.id_or_slug)}`, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function deleteClientSpace(args: z.infer<typeof DeleteClientSpace>) {
  return apiCall('DELETE', `/spaces/${encodeURIComponent(args.id_or_slug)}`);
}

async function setClient(args: z.infer<typeof SetClient>) {
  return apiCall('PATCH', `/sites/${encodeURIComponent(args.id_or_slug)}`, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client: args.client }),
  });
}

// Returns the exact stored HTML (text/html), so the agent can edit it and call
// update_site in place without losing CSS or inline charts. Unlike the rest, this
// returns a raw string rather than JSON.
async function getSite(args: z.infer<typeof GetSite>): Promise<string> {
  const res = await fetch(API_URL + `/sites/${encodeURIComponent(args.id_or_slug)}/content`, {
    headers: { authorization: `Bearer ${API_KEY}` },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`stacktree GET /sites/${args.id_or_slug}/content → ${res.status}: ${text || res.statusText}`);
  }
  return text;
}

// Same owner-scoped route as get_site — GET /sites/{id}/content — so the
// authorisation is identical. `format` is applied to the response here; it
// never picks a different, more permissive route (the public /raw/{token} path
// is keyed on the URL secret rather than the account and refuses gated pages).
async function getContent(args: z.infer<typeof GetContent>): Promise<string> {
  const html = await getSite({ id_or_slug: args.id_or_slug });
  return args.format === 'text' ? stripToText(html) : html;
}

// Cheap HTML-to-text, byte-identical to the worker's (apps/worker/src/raw.ts).
// Good enough for re-ingestion; not a full parser.
function stripToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<\/?(?:p|div|h[1-6]|li|tr|br|hr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  s = s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return s + '\n';
}

async function apiCall(
  method: string,
  path: string,
  init: { body?: FormData | string; headers?: Record<string, string> } = {},
): Promise<unknown> {
  const res = await fetch(API_URL + path, {
    method,
    headers: {
      authorization: `Bearer ${API_KEY}`,
      ...(init.headers || {}),
    },
    body: init.body,
  });
  const text = await res.text();
  let json: unknown;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) {
    throw new Error(`stacktree ${method} ${path} → ${res.status}: ${text || res.statusText}`);
  }
  return json;
}

// Link the agent's wallet to a Stacktree account. Two-step because the MCP holds
// the API key, not the wallet: call with { code } to get the exact message, sign
// it with the agent's own wallet, then call with { code, wallet, signature }. The
// message is deterministic from the code and MUST match the worker's codeMessage.
async function linkWallet(args: z.infer<typeof LinkWallet>) {
  const code = args.code.trim().toUpperCase();
  const message = [
    'Stacktree wallet link',
    `Code: ${code}`,
    '',
    'Signing links this wallet to a Stacktree account and claims its pages. No transaction, no fees.',
  ].join('\n');
  if (!args.wallet || !args.signature) {
    return {
      step: 'sign_then_call_again',
      message,
      instructions:
        'Sign this exact `message` with your wallet using personal_sign (EIP-191). Then call link_wallet again with { code, wallet, signature } — `wallet` is your 0x address, `signature` is the hex signature.',
    };
  }
  // /wallet-links/redeem is public; the API key is ignored there but harmless.
  return await apiCall('POST', '/wallet-links/redeem', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, wallet: args.wallet, signature: args.signature }),
  });
}

async function createShareLink(args: z.infer<typeof CreateShareLink>) {
  const body: Record<string, unknown> = { label: args.label };
  if (typeof args.expires_in_hours === 'number') body.expires_in_hours = args.expires_in_hours;
  if (typeof args.max_uses === 'number') body.max_uses = args.max_uses;
  return apiCall('POST', `/sites/${encodeURIComponent(args.id_or_slug)}/share-tokens`, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function listShareLinks(args: z.infer<typeof ListShareLinks>) {
  return apiCall('GET', `/sites/${encodeURIComponent(args.id_or_slug)}/share-tokens`);
}

async function revokeShareLink(args: z.infer<typeof RevokeShareLink>) {
  return apiCall('DELETE', `/share-tokens/${encodeURIComponent(args.share_link_id)}`);
}

async function listFeedback(args: z.infer<typeof ListFeedback>) {
  return apiCall('GET', `/sites/${encodeURIComponent(args.id_or_slug)}/feedback`);
}

async function resolveFeedback(args: z.infer<typeof ResolveFeedback>) {
  return apiCall('POST', `/feedback/${encodeURIComponent(args.feedback_id)}/resolve`, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ note: args.note ?? null }),
  });
}

// ----- MCP server wiring ---------------------------------------------------

const TOOLS = [
  { name: 'publish_html',     description: 'Turn HTML into a link a person can open in a browser. Reach for this whenever a page you produced has to be seen by someone who is not in this conversation — a client, a teammate, a reviewer, a channel — or when the user says "publish this", "share this", "send it to X", or asks for a preview link to something you built. A rendered preview inside a tool is not a link: if it has to travel, publish it. Returns { url, id, expires_at, ... }; hand the url back. Privacy-first defaults: unlisted token URL, plan-aware expiry (permanent on paid plans, 7 days on free — its ceiling), PII scan in block mode, strict CSP, X-Robots-Tag: noai. Pass expires_in_hours: "never" for a permanent link, which paid plans honour and a capped plan REFUSES with 409 expiry_clamped rather than silently shortening: either resend with accept_clamp: true to take the ceiling, or tell the user the plan cannot make a link permanent, and never report a page as permanent unless expires_at is null. Read expires_at_iso off the response and say that date. Retrying? Pass idempotency_key (any unique string) and a retry returns the SAME page instead of publishing a second one. pii_check: "warn" publishes despite detected sensitive data. A free key allows 3 pages in total and deleting one does not free the slot, so past the third this returns 402 plan_lifetime_limit_exceeded; report that to the user rather than retrying.', schema: PublishHtml,    impl: publishHtml },
  { name: 'update_site',      description: 'Replace the HTML of an existing site in place. The URL stays the same, so everyone you already sent it to sees the new version without being sent anything. Use this — not another publish_html — every time you revise a page you have already published: iterating with publish_html strands the link people are holding on the old version and burns a page slot. The PII pre-flight scan runs on the new content too (MCP default: block; pass pii_check: "warn" to override). A 409 managed_portal means this page is a generated client portal: it rebuilds itself from its space, so direct edits would be overwritten — the owner can "customize" it from the space settings in the dashboard, which stops regeneration for good. A 409 site_deleted means the page has stopped serving and is being kept for 30 days: call restore_site on the same id first, then update it. Do not publish it again, which mints a second page at a different URL.', schema: UpdateSite,     impl: updateSite },
  // Was 'Hard delete a site.' until worker migration 0047 made a delete a
  // two-stage event: the page stops serving now, the content is kept 30 days,
  // and only then is it destroyed. An agent repeating "permanently deleted,
  // nothing we can do" at a user whose page is sitting restorable is the
  // failure that made a customer believe we had lost his work, and it now
  // contradicts the published privacy policy as well. This package is the copy
  // installed agents actually run, so it says what the hosted worker's
  // delete_site (apps/worker/src/mcp.ts) says.
  { name: 'delete_site',      description: 'Take a page down. The link goes dead immediately for everyone holding it, and the content is kept for 30 days: restore_site puts it back at the same URL, with the same id, token, slug and read history, any time in that window. After the 30 days the content is destroyed and cannot be recovered by anyone. So this is undoable, but it is not a preview: tell the user their link stops working now. On the free plan deleting does not hand back a lifetime page slot, because that cap counts publishes rather than live pages. Deleting a page that is already down is not an error: the response comes back with already_deleted: true and the same restorable_until. Read restorable_until (unix seconds) off the response before promising a restore: it is absent when the delete was not recoverable.', schema: DeleteSite,     impl: deleteSite },
  { name: 'restore_site',     description: 'Put a page back at the same URL after it was deleted or ran out of time. Same id, same token, same slug, same read history, so every link already sent starts working again. Call this, and never publish_html, whenever update_site, set_expiry, set_password or another settings call answers 409 site_deleted: publishing the page again mints a different URL, strands everyone holding the old one, and spends another of the free plan\'s three lifetime pages, while a restore spends none of them. Works only inside the 30 days after the page stopped serving, and only for a page its owner deleted or one that expired. A page taken down for abuse is not restorable, and neither is one past its window: both answer 404 with the same body, deliberately. IT IS A RESCUE, NOT A RENEWAL. Read expires_at and restored_for off the response and tell the user that date: restored_for "grace" means the page had run out of time and comes back for 48 hours rather than a fresh full lifetime, while "plan" means it got the normal window for the plan. A 402 plan_site_limit_exceeded means the account is at its live-page limit: take another page down or upgrade, and this one stays restorable until its deadline either way. If a retry answers 404, do not assume the page is gone: call get_site first, because the earlier attempt may have succeeded and a restored page is no longer restorable.', schema: RestoreSite,    impl: restoreSite },
  { name: 'claim_site',       description: 'Adopt a page that was published without an account into the account this key belongs to. Pass the claim_token from the anonymous publish response. Do this whenever you published anonymously and a key is now available: an unclaimed free page dies at 24 hours, and claiming gives it the longest life the plan allows, never a shorter one, with the same URL, id, token and read history. A claim IS a publish: on a free key it spends one of the three lifetime pages and can return 402 plan_lifetime_limit_exceeded or 429 plan_site_limit_exceeded, and the claim link stays valid until the page expires, so report the wall rather than retrying. A wallet-paid page is the exception: it spends no quota and keeps the permanence it paid for. Claiming SPENDS the claim_token — it stops being the page\'s keyless update credential and update_site takes over. Re-claiming a page this account owns answers already: true; 409 already_claimed, 403 invalid_claim_token and 410 are all final.', schema: ClaimSite, impl: claimSite },
  { name: 'get_content',      description: 'Read a page\'s content back. format "html" (the default) returns the exact stored index.html, byte for byte, which is the only form you can edit and hand to update_site; format "text" returns the same page stripped to plain text — no markup, CSS, scripts or SVG — for when you only need to read, summarise or quote it and the markup would be most of the tokens. Only pages this key owns, gated ones included. A page that expired or was deleted still reads back until its restore window closes; one taken down for abuse does not. Never edit the text form and publish it: that throws the page\'s design away.', schema: GetContent, impl: getContent },
  { name: 'get_me',           description: 'Who this key publishes as, and what its plan actually allows: plan, signed-in email, pages held, lifetime publishes spent, and a limits object. READ limits RATHER THAN QUOTING NUMBERS FROM ANY OTHER TOOL DESCRIPTION — those describe the free plan and this key may be on any plan. Worth calling before promising a permanent link (max_expiry_hours), before promising a passcode or email gate (passwords, email_gates), and after a 402 or 429 so you can say which wall was hit. The email also answers "where did my page go": pages live in one account, and the commonest cause of a missing page is a second one.', schema: GetMe, impl: getMe },
  { name: 'set_password',     description: 'Set or clear (null) a passcode on a site. Works on every plan, free keys included. Clearing one always works.', schema: SetPassword,    impl: setPassword },
  { name: 'create_share_link', description: 'Mint a share link addressed to one person. Put their name in label and every open through that link comes back attributed to it, in the dashboard and in the read-receipt email. The link skips the page passcode and can be revoked on its own. One per recipient after publish_html; for a whole mail-merge append ?to={{name}} to the page URL instead.', schema: CreateShareLink, impl: createShareLink },
  { name: 'list_share_links', description: 'Share links on a page with attributed opens and last-opened time. opens counts human page opens through that link; use_count is the raw max_uses counter, not a read metric. opens is null on a plan without viewer numbers.', schema: ListShareLinks, impl: listShareLinks },
  { name: 'revoke_share_link', description: 'Kill one share link. The page and every other link keep working — cut off one recipient without re-issuing to the rest.', schema: RevokeShareLink, impl: revokeShareLink },
  // The description used to say "clamped to the plan ceiling rather than
  // refused", which is what the server did BEFORE the clamp gate and the exact
  // opposite of what its own schema (SetExpiry, above) already told the agent.
  // An agent reads the description; two contradictory sentences in one tool
  // list is worse than either one alone.
  { name: 'set_expiry',       description: 'Set hours-from-now expiry, or null for never. A NUMBER above the plan ceiling is shortened to it (free: 168 hours) and the response says so. null on a plan that caps page lifetime is REFUSED — 409 expiry_clamped, nothing changed — rather than quietly becoming 7 days, so a shortened page can never be reported as permanent: either resend with accept_clamp: true to take the ceiling, or tell the user the plan cannot make this link permanent. Quote expires_at_iso from the response, never the value you asked for.', schema: SetExpiry,      impl: setExpiry },
  { name: 'set_agentation',   description: 'Toggle the on-page Agentation feedback toolbar. When on, viewer annotations are collected — read them with list_feedback, fix the page with update_site, then resolve_feedback.', schema: SetAgentation,  impl: setAgentation },
  { name: 'set_email_gate',   description: 'Restrict viewer access to a specific email domain (strict-equal match). Viewers must verify via a one-time magic link. Mutually exclusive with set_password. Pass domain: null to clear. Email gates are a paid feature: on a free key, setting one returns 402 plan_viewer_gate_not_available.', schema: SetEmailGate,   impl: setEmailGate },
  { name: 'list_sites',       description: 'List sites owned by this API key. Viewer numbers are plan-gated: when metrics_locked is true, view_count, unique_viewers and last_viewed_at are null and only the boolean opened is meaningful. Report "someone opened this" in that case; do not guess or infer a count. Each site carries its client space (or null); filter with the client argument. Pages that expired or were deleted stay in this list rather than disappearing: check deleted_at before handing anyone a url, because a row with deleted_at set is a dead link, and restore_site puts it back until restorable_until passes. delete_reason says which it was: "expired", "owner", or "abuse", and an abuse takedown is never restorable, so do not offer to put one back. Those three fields are absent rather than null against a worker that predates them, so treat a missing deleted_at as live. Paged: when has_more is true, call again passing next_before and next_before_id as before and before_id, and repeat until has_more is false.', schema: ListSites,      impl: listSites },
  { name: 'list_client_spaces', description: 'List the client spaces on this account: slug, name, page_count, last activity, hostname (the space’s own address, e.g. acme.theiragency.com, when one is connected) and portal_enabled (whether the space serves a generated client portal at that address). Spaces group published pages per client ("file this under Acme"). publish_html auto-creates spaces, so an empty list just means nothing has been filed yet — publish with a client to start one. Connecting an address and enabling the portal are done in the dashboard (DNS is involved).', schema: ListClientSpaces, impl: listClientSpaces },
  { name: 'get_design_guide', description: 'Fetch the Stacktree house design guide for improving a published page. Call this BEFORE any request to make a page look better, more polished, more professional, or "beautiful" — it contains the assess-first workflow (including when NOT to restyle a page that already has a deliberate design), the quality floor, and the CSP constraints published pages run under. Then follow it: get_site → assess → rebuild or elevate → update_site.', schema: GetDesignGuide, impl: getDesignGuide },
  { name: 'set_client',       description: 'File an existing site under a client space (by name or slug, auto-created), or pass client: null to detach it to a floating page. Mirrors set_password: one site, one call.', schema: SetClient,      impl: setClient },
  { name: 'create_client_space', description: 'Create a client space before anything is published into it. Rarely needed: publish_html with a client argument auto-creates the space under the same casing and slug rules, so use this only when the user is setting a client up ahead of the work. Idempotent with that auto-create — an existing space matching the name or slug, in any casing, comes back instead of a duplicate. The returned slug is the space’s permanent address segment; a later rename changes the display name only.', schema: CreateClientSpace, impl: createClientSpace },
  { name: 'update_client_space', description: 'Rename a client space, archive or unarchive it, or set the viewer gate that covers every page in the space. Omit a field to leave it untouched. A rename changes the display name only — the slug is a permanent addressing contract and never moves. Archiving keeps everything serving (pages, portal, connected address) and frees the space’s plan slot; unarchiving takes a slot back and returns 402 when the plan is full. password and allowed_email_domain gate the whole space and are inherited by pages already filed under it as well as ones published later; pass null to remove either. Setting a gate is a paid feature: on a free key it returns 402 plan_password_not_available or plan_viewer_gate_not_available. Clearing a gate, or changing one the space already carries, always works. A 409 name_taken means another active space already answers to that name — report that rather than retrying with a variation, which would leave the user with two spaces for one client.', schema: UpdateClientSpace, impl: updateClientSpace },
  { name: 'delete_client_space', description: 'Delete a client space. The pages filed under it are NOT deleted: they detach to floating pages and keep working on their existing URLs, so delivered work stays reachable. The space itself goes, and with it the generated portal page and any address connected to it, which stop resolving. A space-level viewer gate goes with the space too: a page that was protected only by the space passcode or email domain, and carries no gate of its own, becomes reachable by anyone holding its link. Warn the user, and set_password on the pages that have to stay private before deleting. When the user means a client is simply finished, prefer update_client_space with archived: true — archiving keeps the portal and the address live, frees the plan slot, and can be undone.', schema: DeleteClientSpace, impl: deleteClientSpace },
  { name: 'get_site',         description: 'Read the current HTML source of a site you own, so you can edit it and update_site in place. Returns the exact stored index.html (not rendered or text-stripped), preserving CSS and inline charts.', schema: GetSite,        impl: getSite },
  { name: 'link_wallet',      description: 'Link your wallet to a Stacktree account so the pages you publish are owned there — and adopt the ones you already published. Get a LINK-XXXX code from your human (generated at stacktr.ee/wallets). First call with just { code } to get the exact message to sign; sign it with your wallet (personal_sign / EIP-191); then call again with { code, wallet, signature }.', schema: LinkWallet, impl: linkWallet },
  { name: 'list_feedback',    description: 'Read viewer feedback left on a site via the Agentation toolbar. Each item has a comment plus the annotated element, selected text, intent and severity; unresolved items first. The loop: list_feedback → get_site/update_site → resolve_feedback.', schema: ListFeedback, impl: listFeedback },
  { name: 'resolve_feedback', description: 'Mark a feedback item as addressed after fixing the page. Optionally include a note describing the change.', schema: ResolveFeedback, impl: resolveFeedback },
] as const;

const server = new Server(
  { name: 'stacktree', version: '0.0.1' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.schema),
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS.find((t) => t.name === req.params.name);
  if (!tool) throw new Error(`unknown tool: ${req.params.name}`);
  const parsed = tool.schema.parse(req.params.arguments ?? {});
  // The TS narrowing of zod-inferred types via union doesn't survive the indirection;
  // delegating to the implementation function with an `any` cast is safe because each
  // schema gates its own input.
  const result = await (tool.impl as (a: unknown) => Promise<unknown>)(parsed);
  // get_site returns raw HTML; pass strings through verbatim so the agent gets
  // editable source, not a JSON-escaped blob. Everything else is JSON.
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  return { content: [{ type: 'text', text }] };
});

// Minimal zod-to-JSON-schema shim (covers what we need without the extra dep).
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodObject) {
    const props: Record<string, unknown> = {};
    const required: string[] = [];
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    for (const [k, v] of Object.entries(shape)) {
      props[k] = zodToJsonSchema(v);
      if (!(v instanceof z.ZodOptional) && !(v instanceof z.ZodDefault)) required.push(k);
    }
    return { type: 'object', properties: props, ...(required.length ? { required } : {}) };
  }
  if (schema instanceof z.ZodOptional) return zodToJsonSchema(schema.unwrap());
  if (schema instanceof z.ZodDefault) return zodToJsonSchema(schema.removeDefault());
  if (schema instanceof z.ZodNullable) {
    const inner = zodToJsonSchema(schema.unwrap()) as { type?: string };
    return { ...inner, type: [inner.type, 'null'].filter(Boolean) };
  }
  if (schema instanceof z.ZodEnum)   return { type: 'string', enum: schema.options };
  if (schema instanceof z.ZodLiteral) return { const: schema.value };
  if (schema instanceof z.ZodUnion) {
    return { anyOf: schema.options.map((s: z.ZodTypeAny) => zodToJsonSchema(s)) };
  }
  if (schema instanceof z.ZodString)  return { type: 'string', ...(schema.description ? { description: schema.description } : {}) };
  if (schema instanceof z.ZodNumber)  return { type: 'number' };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  return {};
}

await server.connect(new StdioServerTransport());
console.error(`stacktree MCP listening on stdio (api: ${API_URL})`);
