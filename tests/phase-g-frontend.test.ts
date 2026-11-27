import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('..', import.meta.url).pathname;
const html = readFileSync(`${root}public/index.html`, 'utf8');
const js = readFileSync(`${root}public/app.js`, 'utf8');

describe('Phase G frontend wiring', () => {
  it('exposes the Phase G Studio navigation entry', () => {
    expect(html).toContain('data-view="phaseg"');
  });

  it('registers the view and all backend-backed actions', () => {
    expect(js).toContain('phaseg,');
    for (const action of ['phaseg-youtube', 'phaseg-trending', 'phaseg-creators', 'phaseg-score', 'phaseg-sources', 'phaseg-profiles', 'phaseg-quality']) {
      expect(js).toContain(action);
    }
  });
});
