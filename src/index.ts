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
// safer than the raw API. Override per-call when explicit permanence or a
// looser PII mode is needed.
const MCP_DEFAULT_EXPIRY_HOURS = 168;     // 7 days
const MCP_DEFAULT_PII_MODE = 'block' as const;

const PublishHtml = z.object({
  content: z.string().describe('Full HTML to publish.'),
  filename: z.string().default('index.html').describe('Logical filename; defaults to index.html.'),
  password: z.string().optional().describe('Optional password gate (basic-auth on serve).'),
  expires_in_hours: z.union([z.number(), z.literal('never')]).optional()
    .describe('Lifetime in hours, or "never". MCP default: 168 (7 days).'),
  burn_after_read: z.boolean().optional().describe('Auto-delete after first view. Default: false.'),
  agentation: z.boolean().optional().describe('Inject the Agentation feedback toolbar on serve. Default: false.'),
  public_slug: z.string().optional().describe('Opt into a memorable {slug}.stacktr.ee URL. Default: omit (unlisted).'),
  pii_check: z.enum(['off', 'warn', 'block']).optional().describe('PII pre-flight scan mode. MCP default: block.'),
});

const UpdateSite = z.object({
  id_or_slug: z.string().describe('Site id, slug, or unlisted token.'),
  content: z.string().describe('New HTML content.'),
  filename: z.string().default('index.html'),
});

const DeleteSite = z.object({
  id_or_slug: z.string(),
});

const SetPassword = z.object({
  id_or_slug: z.string(),
  password: z.string().nullable().describe('null clears the password.'),
});

const SetExpiry = z.object({
  id_or_slug: z.string(),
  expires_in_hours: z.number().nullable().describe('null = never.'),
});

const SetAgentation = z.object({
  id_or_slug: z.string(),
  enabled: z.boolean(),
});

const SetEmailGate = z.object({
  id_or_slug: z.string(),
  domain: z.string().nullable().describe('Email domain (e.g. "openai.com"); strict-equal, no subdomain match. null clears the gate.'),
});

const ListSites = z.object({}).describe('List sites owned by the API key user.');

// ----- tool implementations ------------------------------------------------

async function publishHtml(args: z.infer<typeof PublishHtml>) {
  const fd = new FormData();
  const blob = new Blob([args.content], { type: 'text/html' });
  fd.append('file', blob, args.filename);
  if (args.password) fd.append('password', args.password);
  // Expiry — apply MCP-tighter default when the caller omits it.
  fd.append(
    'expires_in_hours',
    String(args.expires_in_hours !== undefined ? args.expires_in_hours : MCP_DEFAULT_EXPIRY_HOURS),
  );
  if (args.burn_after_read) fd.append('burn_after_read', 'true');
  if (args.agentation) fd.append('agentation', 'true');
  if (args.public_slug) fd.append('public_slug', args.public_slug);
  // PII — apply MCP-tighter 'block' default when the caller omits it.
  fd.append('pii_check', args.pii_check ?? MCP_DEFAULT_PII_MODE);
  return apiCall('POST', '/sites', { body: fd });
}

async function updateSite(args: z.infer<typeof UpdateSite>) {
  const fd = new FormData();
  const blob = new Blob([args.content], { type: 'text/html' });
  fd.append('file', blob, args.filename);
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

async function listSites() {
  return apiCall('GET', '/sites');
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

// ----- MCP server wiring ---------------------------------------------------

const TOOLS = [
  { name: 'publish_html',     description: 'Publish HTML to stacktr.ee. Returns { url, id, expires_at, ... }. Privacy-first defaults: unlisted token URL, 7-day expiry, PII scan in block mode, strict CSP, X-Robots-Tag: noai. Pass expires_in_hours: "never" for permanent links, or pii_check: "warn" to publish despite detected sensitive data.', schema: PublishHtml,    impl: publishHtml },
  { name: 'update_site',      description: 'Replace the HTML of an existing site in place. The URL stays the same.',                          schema: UpdateSite,     impl: updateSite },
  { name: 'delete_site',      description: 'Hard delete a site.',                                                                              schema: DeleteSite,     impl: deleteSite },
  { name: 'set_password',     description: 'Set or clear (null) a password on a site.',                                                        schema: SetPassword,    impl: setPassword },
  { name: 'set_expiry',       description: 'Set hours-from-now expiry, or null for never.',                                                    schema: SetExpiry,      impl: setExpiry },
  { name: 'set_agentation',   description: 'Toggle the on-page Agentation feedback toolbar.',                                                  schema: SetAgentation,  impl: setAgentation },
  { name: 'set_email_gate',   description: 'Restrict viewer access to a specific email domain (strict-equal match). Viewers must verify via a one-time magic link. Mutually exclusive with set_password. Pass domain: null to clear.', schema: SetEmailGate,   impl: setEmailGate },
  { name: 'list_sites',       description: 'List sites owned by this API key.',                                                                schema: ListSites,      impl: listSites },
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
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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
