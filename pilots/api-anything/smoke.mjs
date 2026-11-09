import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const networkEnv = {};
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS']) {
  if (process.env[key] !== undefined) networkEnv[key] = process.env[key];
}

const client = new Client({ name: 'ugc-api-anything-smoke', version: '0.1.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('./server.mjs', import.meta.url))],
  env: networkEnv,
});

try {
  await client.connect(transport, { timeout: 10_000 });
  const { tools } = await client.listTools({}, { timeout: 5_000 });
  if (tools.length !== 1 || tools[0].name !== 'youtube_search') throw new Error('Unexpected tool list');
  const result = await client.callTool(
    { name: 'youtube_search', arguments: { query: process.argv[2] ?? 'creator video clipping workflow' } },
    undefined,
    { timeout: 30_000 },
  );
  const response = result.structuredContent;
  if (result.isError || response?.ok !== true || response.tier !== 1 ||
      !Array.isArray(response.candidates) || response.candidates.length === 0) {
    throw new Error(`Search did not return Tier 1 candidates (${response?.reason ?? response?.class ?? 'empty_or_invalid'})`);
  }
  console.log(JSON.stringify(response, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
