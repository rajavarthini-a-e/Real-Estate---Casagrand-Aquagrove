#!/usr/bin/env node
'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { SnapServeApi } = require('./snapserve-api');

const api = new SnapServeApi({
  apiKey: process.env.SNAPSERVE_API_KEY || process.env.SNAPSERVE_API_TOKEN || process.env.snapserve_api_token,
  baseUrl: process.env.SNAPSERVE_BASE_URL || process.env.SNAPSERVE_API_BASE_URL || process.env.SNAPSERVE_API_URL
});

const server = new McpServer({ name: 'snapserve', version: '1.0.0' });

function result(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: { data }
  };
}

function failure(error) {
  return {
    isError: true,
    content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }]
  };
}

server.registerTool('snapserve_list_agents', {
  title: 'List SnapServe agents',
  description: 'Returns voice agents available in the connected SnapServe account.',
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: true }
}, async () => {
  try { return result(await api.listAgents()); } catch (error) { return failure(error); }
});

server.registerTool('snapserve_list_calls', {
  title: 'List SnapServe calls',
  description: 'Returns recent SnapServe calls, including summaries, transcripts and recordings when available.',
  inputSchema: {
    limit: z.number().int().min(1).max(500).default(100).describe('Maximum number of calls to return')
  },
  annotations: { readOnlyHint: true, openWorldHint: true }
}, async ({ limit }) => {
  try { return result(await api.listCalls(limit)); } catch (error) { return failure(error); }
});

server.registerTool('snapserve_start_outbound_call', {
  title: 'Start a SnapServe outbound call',
  description: 'Starts a paid outbound call. Use only after an authorized admin action or enabled automatic-call rule.',
  inputSchema: {
    phone: z.string().min(8).describe('Destination phone number in international format'),
    agentId: z.union([z.string(), z.number()]).describe('SnapServe voice agent ID'),
    webhookBaseUrl: z.string().url().optional().describe('Public webhook base URL for call events'),
    metadata: z.record(z.any()).optional().describe('Lead metadata context passed to the agent')
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
}, async ({ phone, agentId, webhookBaseUrl, metadata }) => {
  try { return result(await api.startOutboundCall({ phone, agentId, webhookBaseUrl, metadata })); }
  catch (error) { return failure(error); }
});

async function main() {
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error('SnapServe MCP server failed:', error);
  process.exit(1);
});
