/**
 * Minimal Model Context Protocol (MCP) client over stdio.
 *
 * The discovery worker needs to talk to the API Anything pilot as a real MCP
 * peer: `initialize` handshake, `tools/list`, then `tools/call`. A one-shot
 * child process that prints JSON is not an MCP connection, so this client
 * implements the newline-delimited JSON-RPC 2.0 transport directly instead of
 * pulling the MCP SDK into the server dependency tree.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpContentBlock {
  type: string;
  text?: string;
}

export interface McpToolResult {
  isError: boolean;
  structuredContent?: unknown;
  content: McpContentBlock[];
}

export interface McpStdioClientOptions {
  /** Executable that starts the MCP server (usually `process.execPath`). */
  command: string;
  args?: string[];
  /** Environment for the child process; callers pass an allow-list. */
  env?: NodeJS.ProcessEnv;
  clientName?: string;
  clientVersion?: string;
  /** Timeout for the initialize handshake. */
  connectTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const MAX_STDERR_CHARS = 2_048;

function errorMessage(value: unknown): string {
  return String((value as Error)?.message ?? value ?? 'MCP_ERROR').replace(/\s+/g, ' ').trim().slice(0, 500);
}

export class McpStdioClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stderr = '';
  private closed = false;

  private constructor(
    private readonly child: ChildProcess,
    private readonly reader: Interface,
  ) {
    reader.on('line', (line) => this.handleLine(line));
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-MAX_STDERR_CHARS);
    });
    child.once('exit', (code, signal) => {
      this.closed = true;
      const reason = `MCP_SERVER_EXITED (${signal ?? code ?? 'unknown'})${this.stderr ? `: ${this.stderr}` : ''}`;
      for (const [id, request] of this.pending) {
        clearTimeout(request.timer);
        request.reject(new Error(reason));
        this.pending.delete(id);
      }
    });
    child.once('error', (error) => {
      this.closed = true;
      for (const [id, request] of this.pending) {
        clearTimeout(request.timer);
        request.reject(new Error(`MCP_SERVER_ERROR: ${errorMessage(error)}`));
        this.pending.delete(id);
      }
    });
  }

  static async connect(options: McpStdioClientOptions): Promise<McpStdioClient> {
    const child = spawn(options.command, options.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env,
    });
    const reader = createInterface({ input: child.stdout! });
    const client = new McpStdioClient(child, reader);
    await client.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: options.clientName ?? 'ugc-api-anything-worker',
        version: options.clientVersion ?? '0.1.0',
      },
    }, options.connectTimeoutMs ?? 10_000);
    client.notify('notifications/initialized');
    return client;
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: any;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (message && typeof message === 'object' && typeof message.method === 'string') {
      // Server-initiated request or notification. This client exposes no
      // capabilities, so only acknowledge requests to keep the server moving.
      if (message.id !== undefined && message.id !== null) {
        this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
      }
      return;
    }
    if (!message || typeof message.id !== 'number') return;
    const request = this.pending.get(message.id);
    if (!request) return;
    this.pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) {
      request.reject(new Error(`MCP_RPC_ERROR: ${errorMessage(message.error.message)}`));
    } else {
      request.resolve(message.result);
    }
  }

  private write(message: unknown): void {
    const stdin = this.child.stdin;
    if (this.closed || !stdin?.writable) return;
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params?: unknown, timeoutMs = 15_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('MCP_CLIENT_CLOSED'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP_TIMEOUT: ${method}`));
      }, Math.max(1, timeoutMs));
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  async listTools(): Promise<McpTool[]> {
    const result: any = await this.request('tools/list', {});
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs = 30_000): Promise<McpToolResult> {
    const result: any = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    return {
      isError: result?.isError === true,
      structuredContent: result?.structuredContent,
      content: Array.isArray(result?.content) ? result.content : [],
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.reader.close();
    this.child.stdin?.end();
    this.child.kill('SIGTERM');
  }
}
