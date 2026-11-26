/**
 * Live publishing adapters. Every network call here goes through an injectable
 * fetch (default: globalThis.fetch) and uses only documented, free, official
 * APIs. No credentials, tokens, Authorization headers or upstream payloads are
 * ever returned to callers, written to the database or included in errors.
 *
 * This module never decides whether publishing is allowed. The caller
 * (src/publishing.ts) must have an approved human gate, must have claimed the
 * job and must re-check both before recording any successful result.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { readFile, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { redactText } from '../lib/redaction.js';
import { workspaceMediaPath } from './media-workspace.js';

export type PublishingFetch = typeof globalThis.fetch;
export type PublishingLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
export type PublishingPlatformAdapter = 'youtube' | 'tiktok' | 'instagram';

export interface LivePublishingRequest {
  platform: PublishingPlatformAdapter;
  workspaceId: string;
  jobId: string;
  idempotencyKey: string;
  /** Normalized job options. Media names are basenames only; URLs are https-only. */
  options: Record<string, string | null>;
  /** Only the exact variables required by this platform, copied by the caller. */
  env: Record<string, string>;
}

export interface LivePublishingContext {
  fetch?: PublishingFetch;
  lookup?: PublishingLookup;
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxPolls?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface VerifiedPublishingResult {
  /** A real, verified platform identifier. Never synthesized by this app. */
  externalId: string;
  /** A platform-provided https URL, or null when the API did not return one. */
  url: string | null;
  /** A platform-provided timestamp, or null when the API did not return one. */
  publishedAt: Date | null;
}

export type LivePublishingResult =
  | { ok: true; value: VerifiedPublishingResult }
  | { ok: false; code: string; message: string; retryable: boolean; providerStatus: number | null };

const MAX_JSON_CHARS = 1_000_000;
const MAX_MEDIA_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_POLLS = 10;
const INSTAGRAM_GRAPH_VERSION = 'v21.0';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet%2Cstatus';
const GOOGLE_STATUS_URL = 'https://www.googleapis.com/youtube/v3/videos?part=status';
const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const TIKTOK_INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/video/init/';
const TIKTOK_STATUS_URL = 'https://open.tiktokapis.com/v2/post/publish/status/fetch/';
const INSTAGRAM_TOKEN_URL = `https://graph.facebook.com/${INSTAGRAM_GRAPH_VERSION}/oauth/access_token`;
const INSTAGRAM_GRAPH_BASE = `https://graph.facebook.com/${INSTAGRAM_GRAPH_VERSION}`;

class PublishingAdapterError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly providerStatus: number | null;

  constructor(code: string, message: string, retryable: boolean, providerStatus: number | null = null) {
    super(message);
    this.name = 'PublishingAdapterError';
    this.code = code;
    this.retryable = retryable;
    this.providerStatus = providerStatus;
  }
}

function adapterError(
  code: string,
  message: string,
  retryable: boolean,
  providerStatus: number | null = null,
): PublishingAdapterError {
  return new PublishingAdapterError(code, redactText(message).slice(0, 300), retryable, providerStatus);
}

function requireEnv(request: LivePublishingRequest, name: string): string {
  const value = request.env[name]?.trim();
  if (!value) throw adapterError('NOT_CONFIGURED', `Missing configuration: ${name}`, true);
  return value;
}

function classifyStatus(status: number): { code: string; retryable: boolean } {
  if (status === 401) return { code: 'TOKEN_EXPIRED', retryable: true };
  if (status === 429) return { code: 'RATE_LIMITED', retryable: true };
  if (status >= 500) return { code: 'PLATFORM_TEMPORARY_ERROR', retryable: true };
  if (status >= 400 && status < 500) return { code: 'PLATFORM_VALIDATION_ERROR', retryable: false };
  return { code: 'PLATFORM_RESPONSE_INVALID', retryable: false };
}

function statusMessage(status: number): string {
  if (status === 401) return 'Platform rejected the access token.';
  if (status === 429) return 'Platform rate limit reached.';
  if (status >= 500) return 'Platform is temporarily unavailable.';
  return 'Platform rejected the publishing request.';
}

function ensureOk(response: Response): void {
  if (response.status >= 200 && response.status < 300) return;
  const classification = classifyStatus(response.status);
  throw adapterError(classification.code, statusMessage(response.status), classification.retryable, response.status);
}

function headerRecord(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => { out[key] = value; });
    return out;
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...(headers as Record<string, string>) };
}

async function timedFetch(
  fetchImpl: PublishingFetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  let handle: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    handle = setTimeout(() => {
      try { controller.abort(); } catch { /* already settled */ }
      reject(adapterError('NETWORK_ERROR', 'Platform request timed out.', true));
    }, timeoutMs);
    handle.unref?.();
  });
  try {
    return await Promise.race([
      fetchImpl(url, { ...init, signal: controller.signal }),
      deadline,
    ]);
  } catch (error) {
    if (error instanceof PublishingAdapterError) throw error;
    // Never surface the raw error: injected fetch errors can contain secrets.
    throw adapterError('NETWORK_ERROR', 'Platform request failed.', true);
  } finally {
    if (handle) clearTimeout(handle);
  }
}

async function readJson(response: Response): Promise<any> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw adapterError('NETWORK_ERROR', 'Platform response could not be read.', true);
  }
  if (typeof text !== 'string' || text.length > MAX_JSON_CHARS) {
    throw adapterError('PLATFORM_RESPONSE_INVALID', 'Platform response was too large or empty.', false, response.status);
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw adapterError('PLATFORM_RESPONSE_INVALID', 'Platform returned an invalid response.', false, response.status);
  }
}

async function authedRequest(
  ctx: LivePublishingContext,
  tokenHolder: { value: string },
  url: string,
  init: RequestInit,
  refresh: () => Promise<string>,
  timeoutMs: number,
): Promise<Response> {
  const fetchImpl = ctx.fetch ?? globalThis.fetch;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const headers = headerRecord(init.headers);
    headers.Authorization = `Bearer ${tokenHolder.value}`;
    const response = await timedFetch(fetchImpl, url, { ...init, headers }, timeoutMs);
    if (response.status === 401 && attempt === 0) {
      // Exactly one refresh + retry, as required for real provider 401 codes.
      tokenHolder.value = await refresh();
      continue;
    }
    ensureOk(response);
    return response;
  }
  throw adapterError('TOKEN_EXPIRED', 'Platform rejected credentials after token refresh.', true, 401);
}

async function authedJson(
  ctx: LivePublishingContext,
  tokenHolder: { value: string },
  url: string,
  init: RequestInit,
  refresh: () => Promise<string>,
  timeoutMs: number,
): Promise<any> {
  return readJson(await authedRequest(ctx, tokenHolder, url, init, refresh, timeoutMs));
}

async function refreshTokenRequest(
  ctx: LivePublishingContext,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<string> {
  const fetchImpl = ctx.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await timedFetch(fetchImpl, url, init, timeoutMs);
  } catch (error) {
    if (error instanceof PublishingAdapterError) throw error;
    throw adapterError('NETWORK_ERROR', 'Token request failed.', true);
  }
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    throw adapterError('INVALID_CREDENTIALS', 'Platform rejected the configured credentials.', false, response.status);
  }
  ensureOk(response);
  const json = await readJson(response);
  const token = nonEmptyId(json.access_token ?? json.data?.access_token);
  if (!token) throw adapterError('PLATFORM_RESPONSE_INVALID', 'Token response did not contain an access token.', false, response.status);
  return token;
}

function nonEmptyId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function isPublicIp(address: string): boolean {
  const normalized = String(address ?? '').trim().toLowerCase();
  const family = isIP(normalized);
  if (family === 4) {
    const parts = normalized.split('.').map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [a, b, c] = parts;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 192 && b === 0 && c === 0) return false;
    if (a === 192 && b === 0 && c === 2) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (family === 6) {
    if (normalized === '::' || normalized === '::1') return false;
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return isPublicIp(mapped[1]);
    if (/^(fc|fd|fe[89ab])/i.test(normalized)) return false;
    if (/^2001:db8/i.test(normalized)) return false;
    return true;
  }
  return false;
}

const DNS_NAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

const defaultLookup: PublishingLookup = async (hostname) => {
  const addresses = await dnsLookup(hostname, { all: true });
  return addresses.map((entry) => ({ address: entry.address, family: entry.family }));
};

/** Validate a URL and every resolved address; never allows private/loopback targets. */
export async function assertPublicHttpsUrl(value: unknown, lookup: PublishingLookup = defaultLookup): Promise<string | null> {
  if (typeof value !== 'string' || !value.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
  if (parsed.port && parsed.port !== '443') return null;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (isIP(host)) return isPublicIp(host) ? parsed.toString() : null;
  if (!DNS_NAME_RE.test(host)) return null;
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(host);
  } catch {
    return null;
  }
  if (!Array.isArray(addresses) || addresses.length === 0) return null;
  for (const entry of addresses) {
    if (!entry || !isPublicIp(String(entry.address))) return null;
  }
  return parsed.toString();
}

/** Lightweight, offline check used for platform-provided URLs. */
function isHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function mediaUrlOption(options: Record<string, string | null>): string | null {
  return options.mediaUrl ?? options.videoUrl ?? options.fileUrl ?? null;
}

async function resolvePublicMediaUrl(request: LivePublishingRequest, ctx: LivePublishingContext): Promise<string> {
  const url = await assertPublicHttpsUrl(mediaUrlOption(request.options), ctx.lookup ?? defaultLookup);
  if (!url) throw adapterError('INVALID_MEDIA_INPUT', 'A public https media URL is required.', false);
  return url;
}

const VIDEO_CONTENT_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
};

/** Resolve basenames only through the workspace scratch root; no arbitrary paths. */
async function resolveYouTubeMedia(workspaceId: string, options: Record<string, string | null>) {
  const name = options.mediaName ?? options.mediaFile ?? options.fileName;
  if (typeof name !== 'string' || !name.trim()) {
    throw adapterError('INVALID_MEDIA_INPUT', 'A workspace media basename is required.', false);
  }
  let path: string;
  try {
    path = workspaceMediaPath(workspaceId, name.trim());
  } catch {
    throw adapterError('INVALID_MEDIA_INPUT', 'Invalid workspace media basename.', false);
  }
  const extension = name.trim().split('.').pop()?.toLowerCase() ?? '';
  const contentType = VIDEO_CONTENT_TYPES[extension];
  if (!contentType) throw adapterError('INVALID_MEDIA_INPUT', 'Unsupported media type.', false);
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size < 1 || info.size > MAX_MEDIA_BYTES) {
      throw adapterError('INVALID_MEDIA_INPUT', 'Media file is missing or too large.', false);
    }
    size = info.size;
  } catch (error) {
    if (error instanceof PublishingAdapterError) throw error;
    throw adapterError('INVALID_MEDIA_INPUT', 'Media file is not available.', false);
  }
  return { path, size, contentType };
}

function privacyValue(raw: string | null | undefined): 'public' | 'unlisted' | 'private' {
  const value = String(raw ?? '').trim().toLowerCase();
  return value === 'public' || value === 'unlisted' || value === 'private' ? value : 'private';
}

function youtubePrivacy(raw: string | null | undefined): string {
  return privacyValue(raw);
}

function tiktokPrivacy(raw: string | null | undefined): string {
  const value = privacyValue(raw);
  if (value === 'public') return 'PUBLIC_TO_EVERYONE';
  if (value === 'unlisted') return 'MUTUAL_FOLLOW_FRIENDS';
  return 'SELF_ONLY';
}

function googleSessionUrl(location: string | null): string {
  if (!location) throw adapterError('PLATFORM_RESPONSE_INVALID', 'Upload session was not returned.', false);
  try {
    const parsed = new URL(location);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('unsafe');
    if (parsed.hostname !== 'www.googleapis.com' && !parsed.hostname.endsWith('.googleapis.com')) throw new Error('unsafe');
    return parsed.toString();
  } catch {
    throw adapterError('PLATFORM_RESPONSE_INVALID', 'Upload session URL was invalid.', false);
  }
}

async function refreshGoogleToken(ctx: LivePublishingContext, request: LivePublishingRequest, timeoutMs: number): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: requireEnv(request, 'YOUTUBE_CLIENT_ID'),
    client_secret: requireEnv(request, 'YOUTUBE_CLIENT_SECRET'),
    refresh_token: requireEnv(request, 'YOUTUBE_REFRESH_TOKEN'),
  });
  return refreshTokenRequest(ctx, GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  }, timeoutMs);
}

async function publishYouTube(request: LivePublishingRequest, ctx: LivePublishingContext): Promise<VerifiedPublishingResult> {
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const media = await resolveYouTubeMedia(request.workspaceId, request.options);
  const refresh = () => refreshGoogleToken(ctx, request, timeoutMs);
  const tokenHolder = { value: await refresh() };

  const title = request.options.title?.slice(0, 100) || request.idempotencyKey.slice(0, 100);
  const description = (request.options.description ?? request.options.caption ?? '').slice(0, 5_000);
  const metadata = await authedRequest(ctx, tokenHolder, GOOGLE_UPLOAD_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': media.contentType,
      'X-Upload-Content-Length': String(media.size),
    },
    body: JSON.stringify({
      snippet: { title, description },
      status: { privacyStatus: youtubePrivacy(request.options.visibility) },
    }),
  }, refresh, timeoutMs);
  const sessionUrl = googleSessionUrl(metadata.headers.get('location'));

  let bytes: Buffer;
  try {
    bytes = await readFile(media.path);
  } catch {
    throw adapterError('INVALID_MEDIA_INPUT', 'Media file could not be read.', false);
  }
  if (bytes.length !== media.size) throw adapterError('INVALID_MEDIA_INPUT', 'Media file changed during upload.', false);

  const uploadJson = await authedJson(ctx, tokenHolder, sessionUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': media.contentType,
      'Content-Length': String(bytes.length),
      'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}`,
    },
    body: bytes as unknown as BodyInit,
  }, refresh, timeoutMs);
  const videoId = nonEmptyId(uploadJson.id);
  if (!videoId) throw adapterError('PLATFORM_RESPONSE_INVALID', 'Upload response did not contain a video id.', false);

  const statusJson = await authedJson(ctx, tokenHolder, `${GOOGLE_STATUS_URL}&id=${encodeURIComponent(videoId)}`, {
    method: 'GET',
  }, refresh, timeoutMs);
  const item = Array.isArray(statusJson.items)
    ? statusJson.items.find((entry: any) => entry && entry.id === videoId)
    : null;
  const uploadStatus = item?.status?.uploadStatus;
  if (!item || (uploadStatus !== 'uploaded' && uploadStatus !== 'processed')) {
    throw adapterError('PLATFORM_TEMPORARY_ERROR', 'Uploaded video is not yet available.', true);
  }
  return { externalId: videoId, url: null, publishedAt: null };
}

async function refreshTikTokToken(ctx: LivePublishingContext, request: LivePublishingRequest, timeoutMs: number): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_key: requireEnv(request, 'TIKTOK_CLIENT_KEY'),
    client_secret: requireEnv(request, 'TIKTOK_CLIENT_SECRET'),
    refresh_token: requireEnv(request, 'TIKTOK_REFRESH_TOKEN'),
  });
  return refreshTokenRequest(ctx, TIKTOK_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  }, timeoutMs);
}

async function pollFor<T>(
  ctx: LivePublishingContext,
  probe: () => Promise<{ done: boolean; value?: T }>,
): Promise<T | null> {
  const maxPolls = Math.min(20, Math.max(1, Math.floor(ctx.maxPolls ?? DEFAULT_MAX_POLLS)));
  const intervalMs = Math.max(0, Math.floor(ctx.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
  const sleep = ctx.sleep ?? (async (ms: number) => {
    await new Promise<void>((resolve) => {
      const handle = setTimeout(() => { resolve(); }, ms);
      handle.unref?.();
    });
  });
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    const result = await probe();
    if (result.done) return result.value ?? null;
    if (attempt < maxPolls - 1 && intervalMs > 0) await sleep(intervalMs);
  }
  return null;
}

async function publishTikTok(request: LivePublishingRequest, ctx: LivePublishingContext): Promise<VerifiedPublishingResult> {
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const videoUrl = await resolvePublicMediaUrl(request, ctx);
  const refresh = () => refreshTikTokToken(ctx, request, timeoutMs);
  const tokenHolder = { value: await refresh() };

  const initJson = await authedJson(ctx, tokenHolder, TIKTOK_INIT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      post_info: {
        title: (request.options.title ?? request.options.caption ?? '').slice(0, 150),
        privacy_level: tiktokPrivacy(request.options.visibility),
      },
      source_info: { source: 'PULL_FROM_URL', video_url: videoUrl },
    }),
  }, refresh, timeoutMs);
  const publishId = nonEmptyId(initJson.data?.publish_id);
  if (!publishId) throw adapterError('PLATFORM_RESPONSE_INVALID', 'Publish response did not contain a publish id.', false);

  const externalId = await pollFor<string>(ctx, async () => {
    const statusJson = await authedJson(ctx, tokenHolder, TIKTOK_STATUS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publish_id: publishId }),
    }, refresh, timeoutMs);
    const status = String(statusJson.data?.status ?? '').toUpperCase();
    if (status === 'PUBLISH_COMPLETE') {
      const publicIds = Array.isArray(statusJson.data?.publicaly_available_post_id)
        ? statusJson.data.publicaly_available_post_id
        : [];
      const publicId = nonEmptyId(publicIds[0]);
      return { done: true, value: publicId ?? publishId };
    }
    if (['PUBLISH_FAILED', 'FAILED', 'CANCELLED', 'ERROR'].includes(status)) {
      throw adapterError('PLATFORM_VALIDATION_ERROR', 'Platform rejected the video.', false);
    }
    return { done: false };
  });
  if (!externalId) throw adapterError('PLATFORM_TEMPORARY_ERROR', 'Platform did not confirm publication.', true);
  return { externalId, url: null, publishedAt: null };
}

async function refreshInstagramToken(ctx: LivePublishingContext, request: LivePublishingRequest, timeoutMs: number): Promise<string> {
  const appId = requireEnv(request, 'INSTAGRAM_APP_ID');
  const appSecret = requireEnv(request, 'INSTAGRAM_APP_SECRET');
  const longLivedToken = requireEnv(request, 'INSTAGRAM_ACCESS_TOKEN');
  const url = new URL(INSTAGRAM_TOKEN_URL);
  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', appId);
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('fb_exchange_token', longLivedToken);
  return refreshTokenRequest(ctx, url.toString(), { method: 'GET' }, timeoutMs);
}

function instagramForm(fields: Record<string, string>): { headers: Record<string, string>; body: string } {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) params.set(key, value);
  return {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  };
}

async function publishInstagram(request: LivePublishingRequest, ctx: LivePublishingContext): Promise<VerifiedPublishingResult> {
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const userId = encodeURIComponent(requireEnv(request, 'INSTAGRAM_USER_ID'));
  const videoUrl = await resolvePublicMediaUrl(request, ctx);
  const refresh = () => refreshInstagramToken(ctx, request, timeoutMs);
  const tokenHolder = { value: await refresh() };

  const containerJson = await authedJson(ctx, tokenHolder, `${INSTAGRAM_GRAPH_BASE}/${userId}/media`, {
    method: 'POST',
    ...instagramForm({
      media_type: 'VIDEO',
      video_url: videoUrl,
      caption: (request.options.caption ?? request.options.description ?? '').slice(0, 2_200),
    }),
  }, refresh, timeoutMs);
  const containerId = nonEmptyId(containerJson.id);
  if (!containerId) throw adapterError('PLATFORM_RESPONSE_INVALID', 'Media container response did not contain an id.', false);

  const finished = await pollFor<boolean>(ctx, async () => {
    const statusJson = await authedJson(ctx, tokenHolder, `${INSTAGRAM_GRAPH_BASE}/${encodeURIComponent(containerId)}?fields=status,status_code`, {
      method: 'GET',
    }, refresh, timeoutMs);
    const status = String(statusJson.status ?? '').toUpperCase();
    if (status === 'FINISHED') return { done: true, value: true };
    if (['ERROR', 'EXPIRED'].includes(status)) {
      throw adapterError('PLATFORM_VALIDATION_ERROR', 'Platform rejected the media container.', false);
    }
    return { done: false };
  });
  if (!finished) throw adapterError('PLATFORM_TEMPORARY_ERROR', 'Media container did not finish.', true);

  const publishJson = await authedJson(ctx, tokenHolder, `${INSTAGRAM_GRAPH_BASE}/${userId}/media_publish`, {
    method: 'POST',
    ...instagramForm({ creation_id: containerId }),
  }, refresh, timeoutMs);
  const mediaId = nonEmptyId(publishJson.id);
  if (!mediaId) throw adapterError('PLATFORM_RESPONSE_INVALID', 'Publish response did not contain a media id.', false);
  const url = isHttpsUrl(publishJson.permalink_url ?? publishJson.permalink);
  return { externalId: mediaId, url, publishedAt: null };
}

/**
 * Execute a live official-API publishing flow. The result never contains
 * credentials and never claims success without a verified platform id.
 */
export async function executeLivePublishing(
  request: LivePublishingRequest,
  ctx: LivePublishingContext = {},
): Promise<LivePublishingResult> {
  try {
    let value: VerifiedPublishingResult;
    if (request.platform === 'youtube') value = await publishYouTube(request, ctx);
    else if (request.platform === 'tiktok') value = await publishTikTok(request, ctx);
    else if (request.platform === 'instagram') value = await publishInstagram(request, ctx);
    else throw adapterError('INVALID_PLATFORM', 'Unsupported publishing platform.', false);
    return { ok: true, value };
  } catch (error) {
    if (error instanceof PublishingAdapterError) {
      return {
        ok: false,
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        providerStatus: error.providerStatus,
      };
    }
    return {
      ok: false,
      code: 'NETWORK_ERROR',
      message: 'Publishing adapter failed unexpectedly.',
      retryable: true,
      providerStatus: null,
    };
  }
}
