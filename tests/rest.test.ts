import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { Server } from 'node:http';
import type { RequestHandler } from 'express';
import { buildApp } from '../src/app';
import type { ClaimsVerifier } from '../src/auth/supabase';
import { identify, identifyFromHeader } from '../src/middleware/identity.middleware';
import { JOB_ID, makeService, SEEKER_ID, TEMPLATE_JOB_ID } from './fakes/fixtures';

process.env.NODE_ENV = 'test';

async function start(identity: RequestHandler): Promise<{ url: string; server: Server }> {
  const { service } = makeService();
  const app = buildApp({ resumeService: service, identity, corsOrigin: 'http://localhost:3000', isDatabaseReady: () => true });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

async function call(url: string, method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe('REST API (mock identity)', () => {
  let url = '';
  let server: Server;
  const as = { 'X-User-Id': SEEKER_ID };
  before(async () => ({ url, server } = await start(identifyFromHeader)));
  after(() => server.close());

  it('GET /health needs no identity', async () => {
    const res = await call(url, 'GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.db, 'connected');
  });

  it('rejects calls without a caller', async () => {
    const res = await call(url, 'GET', `/api/drafts/${JOB_ID}`);
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'UNAUTHENTICATED');
  });

  it('runs the whole flow: generate → get → edit → format → approve → approved', async () => {
    assert.equal((await call(url, 'GET', `/api/drafts/${TEMPLATE_JOB_ID}`, as)).status, 404);

    const generated = await call(url, 'POST', `/api/drafts/${TEMPLATE_JOB_ID}/generate`, as);
    assert.equal(generated.status, 201);
    assert.equal(generated.body.format, 'company');

    const sections = generated.body.sections;
    sections[0].included = false;
    const edited = await call(url, 'PUT', `/api/drafts/${TEMPLATE_JOB_ID}/sections`, as, { sections });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.sections[0].included, false);

    const format = await call(url, 'PUT', `/api/drafts/${TEMPLATE_JOB_ID}/format`, as, { format: 'personal' });
    assert.equal(format.body.format, 'personal');

    assert.equal((await call(url, 'GET', `/api/drafts/${TEMPLATE_JOB_ID}/approved`, as)).status, 409);
    const approved = await call(url, 'POST', `/api/drafts/${TEMPLATE_JOB_ID}/approve`, as);
    assert.equal(approved.body.approved, true);

    const fetched = await call(url, 'GET', `/api/drafts/${TEMPLATE_JOB_ID}/approved`, as);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.id, generated.body.id);
  });

  it('validates input with field details', async () => {
    await call(url, 'POST', `/api/drafts/${JOB_ID}/generate`, as);
    const badFormat = await call(url, 'PUT', `/api/drafts/${JOB_ID}/format`, as, { format: 'fancy' });
    assert.equal(badFormat.status, 400);
    assert.equal(badFormat.body.error.details[0].field, 'format');

    const emptyBullet = await call(url, 'PUT', `/api/drafts/${JOB_ID}/sections`, as, {
      sections: [{ id: 'summary', included: true, bullets: [{ id: 'summary-b0', text: '  ' }] }],
    });
    assert.equal(emptyBullet.status, 400);

    const badJob = await call(url, 'GET', '/api/drafts/not%20a%20job', as);
    assert.equal(badJob.status, 400);

    const malformed = await fetch(`${url}/api/drafts/${JOB_ID}/format`, { method: 'PUT', headers: { ...as, 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(malformed.status, 400);
  });
});

describe('REST API (JWT identity)', () => {
  let url = '';
  let server: Server;
  const verify: ClaimsVerifier = async (token) =>
    ({
      'seeker-token': { sub: SEEKER_ID, app_metadata: { role: 'seeker' } },
      'recruiter-token': { sub: SEEKER_ID, app_metadata: { role: 'recruiter' } },
    })[token] ?? null;
  before(async () => ({ url, server } = await start(identify(verify))));
  after(() => server.close());

  it('accepts a seeker token, rejects other roles and bad tokens', async () => {
    assert.equal((await call(url, 'POST', `/api/drafts/${JOB_ID}/generate`, { Authorization: 'Bearer seeker-token' })).status, 201);
    assert.equal((await call(url, 'GET', `/api/drafts/${JOB_ID}`, { Authorization: 'Bearer recruiter-token' })).status, 403);
    assert.equal((await call(url, 'GET', `/api/drafts/${JOB_ID}`, { Authorization: 'Bearer forged' })).status, 401);
    assert.equal((await call(url, 'GET', `/api/drafts/${JOB_ID}`, { 'X-User-Id': SEEKER_ID })).status, 401);
  });
});
