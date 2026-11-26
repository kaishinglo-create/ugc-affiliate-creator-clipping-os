/**
 * Provider catalog for the API Integration Center.
 *
 * This is documentation as data: official portals, real credential names,
 * required permissions, honestly described free tiers and the exact manual
 * steps a user must perform. Nothing here claims a connection. `CONNECTED` is
 * only produced by a successful live probe in `adapters.ts`.
 */

export type ConnectionStatus =
  | 'NOT_CONFIGURED'
  | 'CONFIGURED'
  | 'AUTH_REQUIRED'
  | 'PERMISSION_MISSING'
  | 'CONNECTED'
  | 'TOKEN_EXPIRED'
  | 'RATE_LIMITED'
  | 'QUOTA_EXHAUSTED'
  | 'PROVIDER_UNAVAILABLE'
  | 'ADAPTER_NOT_IMPLEMENTED'
  | 'DISABLED';

export const CONNECTION_STATUSES: readonly ConnectionStatus[] = [
  'NOT_CONFIGURED', 'CONFIGURED', 'AUTH_REQUIRED', 'PERMISSION_MISSING', 'CONNECTED',
  'TOKEN_EXPIRED', 'RATE_LIMITED', 'QUOTA_EXHAUSTED', 'PROVIDER_UNAVAILABLE',
  'ADAPTER_NOT_IMPLEMENTED', 'DISABLED',
];

export type AuthType = 'oauth2' | 'api_key' | 'access_token' | 'refresh_token' | 'local' | 'none';

export interface CredentialField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'url';
  required: boolean;
  help: string;
}

export interface OAuthConfig {
  authorizeUrl: string;
  tokenUrl: string;
  /** S256 PKCE is only enabled where the platform's documented web flow uses it. */
  pkce: boolean;
  scopes: string[];
  defaultRedirectPath: string;
  /** Provider-specific authorize parameters, e.g. Google's access_type=offline. */
  authorizeParams?: Record<string, string>;
  /** TikTok documents client_key and comma-separated scopes for web apps. */
  clientIdParam?: string;
  scopeSeparator?: ' ' | ',';
  tokenField: 'access_token';
  refreshField: 'refresh_token';
}

export interface ProviderDefinition {
  key: string;
  name: string;
  category: string;
  description: string;
  portalUrl: string | null;
  docsUrl: string | null;
  authType: AuthType;
  oauth?: OAuthConfig;
  credentialFields: CredentialField[];
  envKeys: string[];
  requiredPermissions: string[];
  freeTier: string;
  unavailableWithoutCredentials: string[];
  manualSteps: string[];
  officialEndpoints: string[];
  liveAdapter: boolean;
  adapterNote: string;
}

const field = (key: string, label: string, type: CredentialField['type'], required: boolean, help: string): CredentialField => ({ key, label, type, required, help });

export const PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = [
  {
    key: 'youtube_google',
    name: 'Google Cloud / YouTube Data API',
    category: 'Discovery · Upload · Analytics',
    description: 'Official YouTube Data API v3 for channel discovery, metadata and uploads owned by the connected Google account.',
    portalUrl: 'https://console.cloud.google.com/apis/dashboard',
    docsUrl: 'https://developers.google.com/youtube/v3',
    authType: 'oauth2',
    oauth: {
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      pkce: false,
      scopes: ['https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/youtube.upload'],
      defaultRedirectPath: '/api/api-integrations/oauth/youtube_google/callback',
      authorizeParams: { access_type: 'offline', prompt: 'consent' },
      tokenField: 'access_token',
      refreshField: 'refresh_token',
    },
    credentialFields: [
      field('clientId', 'OAuth client ID', 'text', true, 'Create an OAuth client of type "Web application" in Google Cloud Console.'),
      field('clientSecret', 'OAuth client secret', 'password', true, 'Stored encrypted with a separately managed master key; never returned by the API.'),
    ],
    envKeys: ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REFRESH_TOKEN'],
    requiredPermissions: ['YouTube Data API v3 enabled', 'OAuth consent screen configured', 'youtube.readonly for reads', 'youtube.upload only if uploads are enabled'],
    freeTier: 'Google documents a standard quota of 10,000 units per day per Cloud project; exact remaining units are only available in the Cloud quota dashboard. No paid fallback is used.',
    unavailableWithoutCredentials: ['Live channel lookup', 'Playlist and video discovery', 'Authenticated upload preparation'],
    manualSteps: [
      'Create or select a Google Cloud project.',
      'Enable YouTube Data API v3 in the API library.',
      'Configure the OAuth consent screen and add the redirect URI shown by this app.',
      'Create a Web application OAuth client and paste client ID and secret here.',
      'Run "Test connection"; CONNECTED appears only after the real channels.list call succeeds.',
    ],
    officialEndpoints: ['https://www.googleapis.com/youtube/v3/channels', 'https://oauth2.googleapis.com/token'],
    liveAdapter: true,
    adapterNote: 'Documented web-server flow: confidential client, state validation and access_type=offline for refresh tokens. Read-only verification uses channels.list?mine=true; publishing remains behind the existing approval gate.',
  },
  {
    key: 'youtube_analytics',
    name: 'YouTube Analytics API',
    category: 'Analytics',
    description: 'Official YouTube Analytics API v2 for real channel reports of the connected Google account.',
    portalUrl: 'https://console.cloud.google.com/apis/dashboard',
    docsUrl: 'https://developers.google.com/youtube/analytics',
    authType: 'oauth2',
    oauth: {
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      pkce: false,
      scopes: ['https://www.googleapis.com/auth/yt-analytics.readonly'],
      defaultRedirectPath: '/api/api-integrations/oauth/youtube_analytics/callback',
      authorizeParams: { access_type: 'offline', prompt: 'consent' },
      tokenField: 'access_token',
      refreshField: 'refresh_token',
    },
    credentialFields: [
      field('clientId', 'OAuth client ID', 'text', true, 'Reuse the Google Cloud Web application client from YouTube Data API.'),
      field('clientSecret', 'OAuth client secret', 'password', true, 'Stored encrypted with a separately managed master key.'),
    ],
    envKeys: ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REFRESH_TOKEN'],
    requiredPermissions: ['YouTube Analytics API enabled', 'yt-analytics.readonly scope granted', 'OAuth consent screen configured'],
    freeTier: 'Google documents 1 unit per reports query and a standard daily project quota shared with other enabled APIs. Verify the real quota in the Cloud dashboard.',
    unavailableWithoutCredentials: ['Live channel reports', 'Watch-time and revenue metrics', 'Scheduled analytics snapshots from YouTube'],
    manualSteps: [
      'Enable YouTube Analytics API in the same Google Cloud project.',
      'Add the redirect URI of this provider to the OAuth client.',
      'Paste client ID and secret here and run the OAuth authorization.',
      'Run "Test connection"; a real reports query must succeed before CONNECTED is shown.',
    ],
    officialEndpoints: ['https://youtubeanalytics.googleapis.com/v2/reports'],
    liveAdapter: true,
    adapterNote: 'Documented web-server flow: confidential client, state validation and access_type=offline for refresh tokens. Verification performs a minimal last-7-days views report for channel==MINE; no invented metrics are stored.',
  },
  {
    key: 'tiktok',
    name: 'TikTok Developer API',
    category: 'Creator Discovery · Publishing',
    description: 'Official TikTok OAuth and Open API for account verification and later publishing steps.',
    portalUrl: 'https://developers.tiktok.com/',
    docsUrl: 'https://developers.tiktok.com/doc/tiktok-api-v2-get-started',
    authType: 'oauth2',
    oauth: {
      authorizeUrl: 'https://www.tiktok.com/v2/auth/authorize/',
      tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/',
      pkce: false,
      scopes: ['user.info.basic', 'video.publish'],
      defaultRedirectPath: '/api/api-integrations/oauth/tiktok/callback',
      clientIdParam: 'client_key',
      scopeSeparator: ',',
      tokenField: 'access_token',
      refreshField: 'refresh_token',
    },
    credentialFields: [
      field('clientKey', 'Client key', 'text', true, 'Create an app in the TikTok Developer Portal and copy its client key.'),
      field('clientSecret', 'Client secret', 'password', true, 'Stored encrypted; never returned by the API.'),
    ],
    envKeys: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'TIKTOK_REFRESH_TOKEN'],
    requiredPermissions: ['App approved for the required products', 'user.info.basic for identity', 'video.publish only when publishing is enabled'],
    freeTier: 'TikTok does not publish a guaranteed permanent free request quota. Limits depend on app review, product approval and platform policy; no paid fallback is used.',
    unavailableWithoutCredentials: ['Creator identity lookup', 'Live publishing through the existing approval gate', 'Platform-side status checks'],
    manualSteps: [
      'Register an app in the TikTok Developer Portal.',
      'Apply for the User Info and Publishing products and wait for approval.',
      'Register the absolute HTTPS redirect URI shown by this app in the app configuration; TikTok rejects query strings and fragments.',
      'Paste client key and secret here, authorize, then run a connection test.',
    ],
    officialEndpoints: ['https://open.tiktokapis.com/v2/user/info/', 'https://open.tiktokapis.com/v2/oauth/token/'],
    liveAdapter: true,
    adapterNote: 'Documented TikTok web flow: client_key, comma-separated scopes, absolute static HTTPS redirect and state validation. PKCE applies only to TikTok desktop/mobile flows and is not sent here. Verification uses user/info; publishing is never part of a connection test.',
  },
  {
    key: 'instagram_meta',
    name: 'Instagram / Meta Graph API',
    category: 'Reels · Publishing · Insights',
    description: 'Official Meta Graph API for Instagram account verification and reel publishing preparation.',
    portalUrl: 'https://developers.facebook.com/apps/',
    docsUrl: 'https://developers.facebook.com/docs/instagram-api',
    authType: 'oauth2',
    oauth: {
      authorizeUrl: 'https://www.facebook.com/v21.0/dialog/oauth',
      tokenUrl: 'https://graph.facebook.com/v21.0/oauth/access_token',
      pkce: false,
      scopes: ['instagram_basic', 'instagram_content_publish', 'pages_show_list'],
      defaultRedirectPath: '/api/api-integrations/oauth/instagram_meta/callback',
      tokenField: 'access_token',
      refreshField: 'refresh_token',
    },
    credentialFields: [
      field('appId', 'Meta app ID', 'text', true, 'Found in the Meta Developer Portal app dashboard.'),
      field('appSecret', 'Meta app secret', 'password', true, 'Stored encrypted; never returned by the API.'),
    ],
    envKeys: ['INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET', 'INSTAGRAM_ACCESS_TOKEN', 'INSTAGRAM_USER_ID'],
    requiredPermissions: ['Instagram Basic Display / Instagram API product configured', 'Facebook Page connected to the Instagram business account', 'instagram_basic granted', 'instagram_content_publish only when publishing is enabled'],
    freeTier: 'Meta does not guarantee a permanent free quota. API access and rate limits depend on app review and platform policy; no paid fallback is used.',
    unavailableWithoutCredentials: ['Account identity lookup', 'Reel publishing through the existing approval gate', 'Insights retrieval'],
    manualSteps: [
      'Create a Meta app and add the Instagram product.',
      'Connect the Instagram professional account to a Facebook Page.',
      'Add the redirect URI shown by this app to the OAuth settings.',
      'Paste app ID and secret here, authorize, then run a connection test.',
    ],
    officialEndpoints: ['https://graph.facebook.com/v21.0/me', 'https://graph.facebook.com/v21.0/oauth/access_token'],
    liveAdapter: true,
    adapterNote: 'Meta OAuth does not support S256 PKCE in this flow; state validation is mandatory and implemented. Verification uses /me only.',
  },
  {
    key: 'ollama_cloud',
    name: 'Ollama Cloud',
    category: 'KI-Modelle · Agent Runtime',
    description: 'Existing OLLAMA_API_KEY integration for hosted models; used by the AI gateway when configured.',
    portalUrl: 'https://ollama.com/settings/keys',
    docsUrl: 'https://docs.ollama.com/api',
    authType: 'api_key',
    credentialFields: [field('apiKey', 'Ollama API key', 'password', true, 'Create a key in the Ollama account settings. Stored encrypted.')],
    envKeys: ['OLLAMA_API_KEY', 'OLLAMA_BASE_URL'],
    requiredPermissions: ['Valid Ollama account with an active key', 'Sufficient account credits for hosted inference'],
    freeTier: 'Ollama Cloud is a paid service. A 402 response means the cloud account has no credits; this app does not switch to a paid fallback and does not report a fake success.',
    unavailableWithoutCredentials: ['Hosted model chat', 'AI gateway cloud provider', 'Agent runtime when AGENT_AI_MODE=required'],
    manualSteps: [
      'Create an Ollama account and generate an API key in account settings.',
      'Enter the key here or set OLLAMA_API_KEY server-side.',
      'Run "Test connection"; the read-only model listing must succeed before CONNECTED is shown.',
    ],
    officialEndpoints: ['https://ollama.com/api/tags'],
    liveAdapter: true,
    adapterNote: 'Verification lists models only; it does not send a paid generation request.',
  },
  {
    key: 'ollama_local',
    name: 'Ollama Local',
    category: 'KI-Modelle · lokal kostenlos',
    description: 'Local Ollama daemon on loopback. No credentials, no external network calls and no cost.',
    portalUrl: null,
    docsUrl: 'https://docs.ollama.com/api',
    authType: 'local',
    credentialFields: [],
    envKeys: [],
    requiredPermissions: ['Ollama daemon listening on 127.0.0.1:11434'],
    freeTier: 'Free and local. Model downloads may require network access but inference itself has no provider fee.',
    unavailableWithoutCredentials: ['Local model listing', 'Free local inference when the daemon is running'],
    manualSteps: [
      'Install Ollama locally and start its daemon.',
      'Pull at least one model with the official Ollama CLI.',
      'Run "Test connection"; /api/tags on loopback must succeed.',
    ],
    officialEndpoints: ['http://127.0.0.1:11434/api/tags'],
    liveAdapter: true,
    adapterNote: 'Only the literal loopback endpoint is allowed. No user-supplied URL is fetched, preventing SSRF.',
  },
  {
    key: 'opencode_free',
    name: 'OpenCode Free Provider',
    category: 'Coding · Free-Model-Routing',
    description: 'Free-model routing from the existing scripts/free-models.json allowlist; no credentials are stored in the UGC app.',
    portalUrl: 'https://opencode.ai/docs/',
    docsUrl: 'https://opencode.ai/docs/models/',
    authType: 'none',
    credentialFields: [],
    envKeys: [],
    requiredPermissions: ['scripts/free-models.json must contain verified zero-cost models'],
    freeTier: 'The allowlist was verified on 2026-11-24 with opencode models: every listed model has input=0, output=0 and cache.read/write=0. No paid fallback is used.',
    unavailableWithoutCredentials: ['Free model routing', 'Automated coding tasks through the controller'],
    manualSteps: [
      'Keep scripts/free-models.json updated from `opencode models`.',
      'Confirm each model still reports zero cost before adding it to the allowlist.',
      'Run "Test connection"; the file must exist and contain at least one free model.',
    ],
    officialEndpoints: ['scripts/free-models.json'],
    liveAdapter: true,
    adapterNote: 'This is a local verified-adapter check, not a remote login. No OpenCode server password is stored here.',
  },
  {
    key: 'api_anything_mcp',
    name: 'API Anything MCP',
    category: 'MCP · externe Datenquellen',
    description: 'Existing stdio MCP client used by real discovery jobs and the agent browser.',
    portalUrl: 'https://modelcontextprotocol.io/',
    docsUrl: 'https://modelcontextprotocol.io/docs/concepts/architecture',
    authType: 'local',
    credentialFields: [],
    envKeys: ['DISCOVERY_MCP_SERVER', 'DISCOVERY_MCP_CLIENT'],
    requiredPermissions: ['DISCOVERY_MCP_SERVER must point to an installed local MCP server (or the bundled pilot)'],
    freeTier: 'The bundled pilot server runs locally and is free. External registries may require their own keys and are not contacted automatically.',
    unavailableWithoutCredentials: ['Live MCP discovery', 'MCP tool listing', 'External data-source calls'],
    manualSteps: [
      'Install the bundled pilot dependencies if using pilots/api-anything/server.mjs.',
      'Set DISCOVERY_MCP_SERVER to the absolute path of the MCP server.',
      'Run "Test connection"; initialize and tools/list must succeed over stdio.',
    ],
    officialEndpoints: ['stdio JSON-RPC 2.0 (initialize, tools/list)'],
    liveAdapter: true,
    adapterNote: 'Reuses src/mcp-client.ts. No external registry key is invented or requested.',
  },
  {
    key: 'affiliate_networks',
    name: 'Affiliate Networks',
    category: 'Kampagnen · Provisionen',
    description: 'Local attribution and payout ledger. Network-specific API adapters are not implemented in this build.',
    portalUrl: null,
    docsUrl: null,
    authType: 'none',
    credentialFields: [],
    envKeys: [],
    requiredPermissions: ['No network credentials are requested because no official adapter is implemented'],
    freeTier: 'Local attribution and conversion records are free. No external network account is contacted.',
    unavailableWithoutCredentials: ['Network-side campaign sync', 'Network-side commission reports', 'Automatic offer discovery'],
    manualSteps: [
      'Use the existing local affiliate attribution and payout workflow.',
      'Export campaign data manually for any external network.',
      'An official adapter must be implemented before credentials can be accepted here.',
    ],
    officialEndpoints: [],
    liveAdapter: false,
    adapterNote: 'ADAPTER_NOT_IMPLEMENTED is returned even if credentials exist; no fake connection is possible.',
  },
  {
    key: 'external_analytics',
    name: 'External Analytics Provider',
    category: 'Analytics',
    description: 'Workspace analytics currently come from local snapshots only; no third-party analytics adapter is implemented.',
    portalUrl: 'https://developers.google.com/analytics/devguides/reporting/data/v1',
    docsUrl: 'https://developers.google.com/analytics/devguides/reporting/data/v1',
    authType: 'none',
    credentialFields: [],
    envKeys: [],
    requiredPermissions: ['No third-party analytics credential is requested in this build'],
    freeTier: 'Local snapshots and reports are free. An external API would have its own provider-specific quota and must be implemented and verified first.',
    unavailableWithoutCredentials: ['Third-party analytics import', 'Cross-platform attribution', 'Automated external reporting'],
    manualSteps: [
      'Keep using local AnalyticsSnapshot data.',
      'Publishing metrics may be imported only through a verified adapter.',
      'No credential entry is offered until such an adapter exists.',
    ],
    officialEndpoints: [],
    liveAdapter: false,
    adapterNote: 'ADAPTER_NOT_IMPLEMENTED is honest here; local analytics remain available.',
  },
  {
    key: 'yaps',
    name: 'Yaps Video Clipping',
    category: 'Legacy clipping integration',
    description: 'Existing credential-presence integration with no live adapter.',
    portalUrl: null,
    docsUrl: null,
    authType: 'api_key',
    credentialFields: [field('apiKey', 'API key', 'password', true, 'Existing YAPS_API_KEY presence check only.')],
    envKeys: ['YAPS_API_KEY'],
    requiredPermissions: ['Existing environment variable only'],
    freeTier: 'Unknown; no live API call is made by this build.',
    unavailableWithoutCredentials: ['Silence removal through a live adapter'],
    manualSteps: ['Set YAPS_API_KEY server-side if the external tool requires it. No live connection test exists.'],
    officialEndpoints: [],
    liveAdapter: false,
    adapterNote: 'ADAPTER_NOT_IMPLEMENTED: status can never become CONNECTED.',
  },
  {
    key: 'clippingmini',
    name: 'ClippingMini Bookmarks',
    category: 'Legacy clipping integration',
    description: 'Existing credential-presence integration with no live adapter.',
    portalUrl: null,
    docsUrl: null,
    authType: 'api_key',
    credentialFields: [field('apiKey', 'API key', 'password', true, 'Existing CLIPPINGMINI_API_KEY presence check only.')],
    envKeys: ['CLIPPINGMINI_API_KEY'],
    requiredPermissions: ['Existing environment variable only'],
    freeTier: 'Unknown; no live API call is made by this build.',
    unavailableWithoutCredentials: ['Bookmark sync through a live adapter'],
    manualSteps: ['Set CLIPPINGMINI_API_KEY server-side if the external tool requires it. No live connection test exists.'],
    officialEndpoints: [],
    liveAdapter: false,
    adapterNote: 'ADAPTER_NOT_IMPLEMENTED: status can never become CONNECTED.',
  },
  {
    key: 'klap',
    name: 'Klap',
    category: 'Legacy clipping integration',
    description: 'Existing credential-presence integration with no live adapter.',
    portalUrl: null,
    docsUrl: null,
    authType: 'api_key',
    credentialFields: [field('apiKey', 'API key', 'password', true, 'Existing KLAP_API_KEY presence check only.')],
    envKeys: ['KLAP_API_KEY'],
    requiredPermissions: ['Existing environment variable only'],
    freeTier: 'Unknown; no live API call is made by this build.',
    unavailableWithoutCredentials: ['Short-clip generation through a live adapter'],
    manualSteps: ['Set KLAP_API_KEY server-side if the external tool requires it. No live connection test exists.'],
    officialEndpoints: [],
    liveAdapter: false,
    adapterNote: 'ADAPTER_NOT_IMPLEMENTED: status can never become CONNECTED.',
  },
  {
    key: 'opusclip',
    name: 'AI Producer by OpusClip',
    category: 'Legacy clipping integration',
    description: 'Existing credential-presence integration with no live adapter.',
    portalUrl: null,
    docsUrl: null,
    authType: 'api_key',
    credentialFields: [field('apiKey', 'API key', 'password', true, 'Existing OPUSCLIP_API_KEY presence check only.')],
    envKeys: ['OPUSCLIP_API_KEY'],
    requiredPermissions: ['Existing environment variable only'],
    freeTier: 'Unknown; no live API call is made by this build.',
    unavailableWithoutCredentials: ['AI editing through a live adapter'],
    manualSteps: ['Set OPUSCLIP_API_KEY server-side if the external tool requires it. No live connection test exists.'],
    officialEndpoints: [],
    liveAdapter: false,
    adapterNote: 'ADAPTER_NOT_IMPLEMENTED: status can never become CONNECTED.',
  },
];

const BY_KEY = new Map(PROVIDER_DEFINITIONS.map((provider) => [provider.key, provider]));

export function getProviderDefinition(key: unknown): ProviderDefinition | null {
  return typeof key === 'string' ? BY_KEY.get(key) ?? null : null;
}

export const OAUTH_PROVIDER_KEYS: readonly string[] = PROVIDER_DEFINITIONS
  .filter((provider) => provider.oauth)
  .map((provider) => provider.key);
