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
  password: z.string().optional().describe('Optional passcode gate on serve. Paid plans only; a free key gets 402 plan_password_not_available.'),
  expires_in_hours: z.union([z.number(), z.literal('never')]).optional()
    .describe('Lifetime in hours, or "never". Default when omitted: permanent on paid plans, 7 days on the free plan (its ceiling). Clamped to the plan ceiling, not rejected: a free key caps at 168 whatever you pass. Read expires_at in the response for what the page actually got.'),
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

const SetPassword = z.object({
  id_or_slug: z.string(),
  password: z.string().nullable().describe('null clears the passcode. Setting one needs a paid plan; clearing one always works.'),
});

const SetExpiry = z.object({
  id_or_slug: z.string(),
  expires_in_hours: z.number().nullable().describe('null = never, on a plan that allows it. Clamped to the plan ceiling otherwise (free: 168 hours).'),
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
  return apiCall('POST', '/sites', { body: fd });
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

async function setPassword(args: z.infer<typeof SetPassword>) {
  return apiCall('PATCH', `/sites/${encodeURIComponent(args.id_or_slug)}`, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: args.password }),
  });
}

async function setExpiry(args: z.infer<typeof SetExpiry>) {
  return apiCall('PATCH', `/sites/${encodeURIComponent(args.id_or_slug)}`, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expires_in_hours: args.expires_in_hours }),
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
  { name: 'publish_html',     description: 'Publish HTML to stacktr.ee. Returns { url, id, expires_at, ... }. Privacy-first defaults: unlisted token URL, plan-aware expiry (permanent on paid plans, 7 days on free — its ceiling), PII scan in block mode, strict CSP, X-Robots-Tag: noai. Pass expires_in_hours: "never" for a permanent link, which paid plans honour and a free key clamps back to 7 days; pii_check: "warn" publishes despite detected sensitive data. A free key allows 3 pages in total and deleting one does not free the slot, so past the third this returns 402 plan_lifetime_limit_exceeded; report that to the user rather than retrying.', schema: PublishHtml,    impl: publishHtml },
  { name: 'update_site',      description: 'Replace the HTML of an existing site in place. The URL stays the same. The PII pre-flight scan runs on the new content too (MCP default: block; pass pii_check: "warn" to override). A 409 managed_portal means this page is a generated client portal: it rebuilds itself from its space, so direct edits would be overwritten — the owner can "customize" it from the space settings in the dashboard, which stops regeneration for good.', schema: UpdateSite,     impl: updateSite },
  { name: 'delete_site',      description: 'Hard delete a site.',                                                                              schema: DeleteSite,     impl: deleteSite },
  { name: 'set_password',     description: 'Set or clear (null) a passcode on a site. Passcodes are a paid feature: on a free key, setting one returns 402 plan_password_not_available. Clearing one always works.', schema: SetPassword,    impl: setPassword },
  { name: 'set_expiry',       description: 'Set hours-from-now expiry, or null for never. The value is clamped to the plan ceiling rather than refused, so on a free key null and any value above 168 both land at 7 days from now. Check expires_at in the response.', schema: SetExpiry,      impl: setExpiry },
  { name: 'set_agentation',   description: 'Toggle the on-page Agentation feedback toolbar. When on, viewer annotations are collected — read them with list_feedback, fix the page with update_site, then resolve_feedback.', schema: SetAgentation,  impl: setAgentation },
  { name: 'set_email_gate',   description: 'Restrict viewer access to a specific email domain (strict-equal match). Viewers must verify via a one-time magic link. Mutually exclusive with set_password. Pass domain: null to clear. Email gates are a paid feature: on a free key, setting one returns 402 plan_viewer_gate_not_available.', schema: SetEmailGate,   impl: setEmailGate },
  { name: 'list_sites',       description: 'List sites owned by this API key. Viewer numbers are plan-gated: when metrics_locked is true, view_count, unique_viewers and last_viewed_at are null and only the boolean opened is meaningful. Report "someone opened this" in that case; do not guess or infer a count. Each site carries its client space (or null); filter with the client argument. Paged: when has_more is true, call again passing next_before and next_before_id as before and before_id, and repeat until has_more is false.', schema: ListSites,      impl: listSites },
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
