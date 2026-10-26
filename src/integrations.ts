export type Provider = 'yaps' | 'clippingmini' | 'klap' | 'opusclip';

export interface ProviderInfo {
  provider: Provider;
  name: string;
  description: string;
  envKey: string;
  configured: boolean;
  capabilities: string[];
}

export const PROVIDERS: ProviderInfo[] = [
  { provider: 'yaps', name: 'Yaps Video Clipping', description: 'Remove silence and pauses', envKey: 'YAPS_API_KEY', configured: !!process.env.YAPS_API_KEY, capabilities: ['silence_removal'] },
  { provider: 'clippingmini', name: 'ClippingMini Bookmarks', description: 'Reference bookmarks', envKey: 'CLIPPINGMINI_API_KEY', configured: !!process.env.CLIPPINGMINI_API_KEY, capabilities: ['bookmarks'] },
  { provider: 'klap', name: 'Klap', description: 'Short clips from long videos', envKey: 'KLAP_API_KEY', configured: !!process.env.KLAP_API_KEY, capabilities: ['short_clips'] },
  { provider: 'opusclip', name: 'AI Producer by OpusClip', description: 'AI editing/captions/reframing', envKey: 'OPUSCLIP_API_KEY', configured: !!process.env.OPUSCLIP_API_KEY, capabilities: ['ai_edit'] },
];

export function providerStatus(provider: Provider): 'NOT_CONFIGURED' | 'CONFIGURED' {
  return PROVIDERS.find((p) => p.provider === provider)?.configured ? 'CONFIGURED' : 'NOT_CONFIGURED';
}
