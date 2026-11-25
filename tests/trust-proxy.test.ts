import { describe, expect, it } from 'vitest';
import { resolveTrustProxy } from '../src/config.js';

describe('deterministic proxy trust', () => {
  it('trusts proxies only when explicitly enabled', () => {
    expect(resolveTrustProxy('true')).toBe(true);
    expect(resolveTrustProxy('1')).toBe(true);
    expect(resolveTrustProxy(' TRUE ')).toBe(true);
  });

  it('supports loopback and a fixed hop count', () => {
    expect(resolveTrustProxy('loopback')).toBe('loopback');
    expect(resolveTrustProxy('2')).toBe(2);
  });

  it('fails closed for unset or invalid values', () => {
    expect(resolveTrustProxy(undefined)).toBe(false);
    expect(resolveTrustProxy('')).toBe(false);
    expect(resolveTrustProxy('yes')).toBe(false);
    expect(resolveTrustProxy('-1')).toBe(false);
  });
});
