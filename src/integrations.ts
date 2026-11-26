export type Provider = 'yaps' | 'clippingmini' | 'klap' | 'opusclip';

export interface ProviderInfo {
  provider: Provider;
  name: string;
  description: string;
  envKey: string;
  /** Credentials are present; this is not a live connection. */
  credentialsPresent: boolean;
  capabilities: string[];
}

export const PROVIDERS: ProviderInfo[] = [
  { provider: 'yaps', name: 'Yaps Video Clipping', description: 'Remove silence and pauses', envKey: 'YAPS_API_KEY', credentialsPresent: !!process.env.YAPS_API_KEY, capabilities: ['silence_removal'] },
  { provider: 'clippingmini', name: 'ClippingMini Bookmarks', description: 'Reference bookmarks', envKey: 'CLIPPINGMINI_API_KEY', credentialsPresent: !!process.env.CLIPPINGMINI_API_KEY, capabilities: ['bookmarks'] },
  { provider: 'klap', name: 'Klap', description: 'Short clips from long videos', envKey: 'KLAP_API_KEY', credentialsPresent: !!process.env.KLAP_API_KEY, capabilities: ['short_clips'] },
  { provider: 'opusclip', name: 'AI Producer by OpusClip', description: 'AI editing/captions/reframing', envKey: 'OPUSCLIP_API_KEY', credentialsPresent: !!process.env.OPUSCLIP_API_KEY, capabilities: ['ai_edit'] },
];

/**
 * Public status vocabulary. There is no live provider adapter in this build,
 * so credentials can only ever be reported as stored credentials.
 */
export type IntegrationStatus = 'NOT_CONFIGURED' | 'CREDENTIALS_ONLY';

export function providerStatus(provider: Provider): 'NOT_CONFIGURED' | 'CONFIGURED' {
  return PROVIDERS.find((p) => p.provider === provider)?.credentialsPresent ? 'CONFIGURED' : 'NOT_CONFIGURED';
}

export function resolveIntegrationStatus(provider: Provider, storedStatus?: string | null): IntegrationStatus {
  const hasCredentials = storedStatus === 'CONFIGURED' || providerStatus(provider) === 'CONFIGURED';
  return hasCredentials ? 'CREDENTIALS_ONLY' : 'NOT_CONFIGURED';
}
