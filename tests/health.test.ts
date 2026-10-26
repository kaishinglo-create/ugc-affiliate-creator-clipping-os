import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/index.js';

describe('health', () => {
  it('returns ok', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});
