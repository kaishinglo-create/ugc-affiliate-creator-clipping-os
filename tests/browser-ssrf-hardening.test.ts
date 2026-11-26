import { describe, expect, it } from 'vitest';
import { validateBrowserUrl } from '../src/browser-gateway.js';

describe('browser URL SSRF hardening', () => {
  it('blocks literal loopback, private and metadata addresses in every notation', async () => {
    for (const url of [
      'http://127.0.0.1/secret',
      'http://2130706433/secret',
      'http://0x7f000001/secret',
      'http://[::1]/secret',
      'http://[::ffff:127.0.0.1]/secret',
      'http://169.254.169.254/latest/meta-data',
      'http://10.1.2.3/secret',
      'http://192.168.1.1/secret',
      'http://localhost:3000/secret',
    ]) {
      await expect(validateBrowserUrl(url), url).rejects.toThrow('URL_HOST_NOT_ALLOWED');
    }
  });

  it('rejects unsupported protocols and embedded credentials', async () => {
    await expect(validateBrowserUrl('ftp://example.com/file')).rejects.toThrow('URL_PROTOCOL_NOT_ALLOWED');
    await expect(validateBrowserUrl('http://user:pass@example.com/')).rejects.toThrow('URL_CREDENTIALS_NOT_ALLOWED');
  });

  it('resolves hostnames and accepts a genuinely public target', async () => {
    await expect(validateBrowserUrl('https://example.com/path?q=1')).resolves.toBe('https://example.com/path?q=1');
  });
});
