/**
 * Honest local capability matrix for provider analytics/insights and affiliate
 * networks. Missing credentials block only external live verification; the
 * local status/reporting layer is implemented here.
 */
export interface ProviderCapability {
  platform: string;
  capability: string;
  localImplementation: 'IMPLEMENTED' | 'EXTERNAL_CONTRACT_ONLY';
  requiredEnv: string[];
}

export const PROVIDER_CAPABILITIES: ProviderCapability[] = [
  {
    platform: 'youtube',
    capability: 'analytics',
    localImplementation: 'IMPLEMENTED',
    requiredEnv: ['YOUTUBE_ACCESS_TOKEN'],
  },
  {
    platform: 'tiktok',
    capability: 'creator_info',
    localImplementation: 'IMPLEMENTED',
    requiredEnv: ['TIKTOK_ACCESS_TOKEN'],
  },
  {
    platform: 'instagram',
    capability: 'insights',
    localImplementation: 'IMPLEMENTED',
    requiredEnv: ['INSTAGRAM_ACCESS_TOKEN'],
  },
  {
    platform: 'affiliate',
    capability: 'network_webhooks',
    localImplementation: 'IMPLEMENTED',
    requiredEnv: ['AFFILIATE_WEBHOOK_SECRET'],
  },
];

export function providerCapabilityStatus(capability: ProviderCapability): {
  platform: string;
  capability: string;
  status: 'NOT_CONFIGURED' | 'LIVE_VERIFICATION_PENDING';
  missingEnv: string[];
  externalLiveBlocked: boolean;
} {
  const missingEnv = capability.requiredEnv.filter((name) => !String(process.env[name] ?? '').trim());
  return {
    platform: capability.platform,
    capability: capability.capability,
    status: missingEnv.length ? 'NOT_CONFIGURED' : 'LIVE_VERIFICATION_PENDING',
    missingEnv,
    externalLiveBlocked: missingEnv.length > 0,
  };
}

export function listProviderCapabilities() {
  return PROVIDER_CAPABILITIES.map((capability) => ({
    localImplementation: capability.localImplementation,
    ...providerCapabilityStatus(capability),
  }));
}
