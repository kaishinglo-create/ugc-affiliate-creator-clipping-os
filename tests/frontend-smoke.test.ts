import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../src/index.js';

describe('frontend smoke', () => {
  let app: any;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); });

  it('serves index.html', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('UGC OS');
  });

  it('serves app.js', async () => {
    const res = await app.inject({ method: 'GET', url: '/app.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
  });

  it('serves styles.css', async () => {
    const res = await app.inject({ method: 'GET', url: '/styles.css' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/css');
  });

  it('serves favicon', async () => {
    const res = await app.inject({ method: 'GET', url: '/favicon.ico' });
    expect(res.statusCode).toBe(200);
  });

  it('blocks unauthenticated /api/auth/me', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('blocks unauthenticated /api/products', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/products' });
    expect(res.statusCode).toBe(401);
  });
});
