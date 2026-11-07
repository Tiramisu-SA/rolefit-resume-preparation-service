import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it, mock } from 'node:test';
import * as grpc from '@grpc/grpc-js';
import { FallbackTailorAdapter } from '../src/adapters/ai/fallback.adapter';
import { RuleBasedTailorAdapter } from '../src/adapters/ai/rule-based.adapter';
import { buildApp } from '../src/app';
import { CandidateProfileClient } from '../src/grpc/candidate-profile.client';
import { callerMetadata, loadProto, Msg } from '../src/grpc/grpc.utils';
import { JobPostingClient } from '../src/grpc/job-posting.client';
import { startGrpcServer } from '../src/grpc/resume-preparation.grpc';
import { identifyFromHeader } from '../src/middleware/identity.middleware';
import { logger } from '../src/utils/logger';
import { JOB_ID, makeJob, makeProfile, makeService, seeker, SEEKER_ID } from './fakes/fixtures';

process.env.NODE_ENV = 'test';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type LogLine = Record<string, unknown>;

/** Runs `fn` with the logger switched on and returns the JSON lines it printed. A line that is not JSON fails the test. */
async function captureLogs(fn: () => Promise<void>): Promise<LogLine[]> {
  const spies = (['log', 'warn', 'error'] as const).map((level) => mock.method(console, level, () => {}));
  process.env.NODE_ENV = 'development';
  try {
    await fn();
    await new Promise((resolve) => setTimeout(resolve, 20)); // let 'finish' handlers run
    return spies.flatMap((spy) => spy.mock.calls.map((c) => JSON.parse(String(c.arguments[0])) as LogLine));
  } finally {
    process.env.NODE_ENV = 'test';
    for (const spy of spies) spy.mock.restore();
  }
}

const errorMessage = (line: LogLine) => (line.error as { message?: string } | undefined)?.message;

describe('X-Request-Id (REST)', () => {
  let url = '';
  let server: Server;
  const { service, profiles } = makeService();

  before(async () => {
    const app = buildApp({ resumeService: service, identity: identifyFromHeader, corsOrigin: 'http://localhost:3000', isDatabaseReady: () => true });
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  const get = (headers: Record<string, string> = {}) => fetch(`${url}/api/drafts/${JOB_ID}`, { headers: { 'X-User-Id': SEEKER_ID, ...headers } });

  it("returns the gateway's id on the response", async () => {
    const res = await get({ 'X-Request-Id': 'gw-req-123' });
    assert.equal(res.headers.get('x-request-id'), 'gw-req-123');
  });

  it('creates a UUID when the id is missing or unsafe', async () => {
    assert.match((await get()).headers.get('x-request-id')!, UUID);
    assert.match((await get({ 'X-Request-Id': 'evil id; injected' })).headers.get('x-request-id')!, UUID);
    assert.match((await get({ 'X-Request-Id': 'x'.repeat(129) })).headers.get('x-request-id')!, UUID);
  });

  it('forwards the id to the Candidate Profile Service when generating a draft', async () => {
    const res = await fetch(`${url}/api/drafts/${JOB_ID}/generate`, { method: 'POST', headers: { 'X-User-Id': SEEKER_ID, 'X-Request-Id': 'gw-gen-1' } });
    assert.equal(res.status, 201);
    assert.equal(profiles.requestIds.at(-1), 'gw-gen-1');
  });

  it('logs one JSON line per request with the id, method, path without query, status and duration', async () => {
    const lines = await captureLogs(async () => {
      await fetch(`${url}/api/drafts/${JOB_ID}?private=typed-by-user`, { headers: { 'X-User-Id': SEEKER_ID, 'X-Request-Id': 'gw-log-1' } });
    });
    const line = lines.find((l) => l.requestId === 'gw-log-1');
    assert.ok(line, `no request log line in: ${JSON.stringify(lines)}`);
    assert.equal(line.service, 'resume-preparation');
    assert.equal(line.level, 'info');
    assert.equal(line.message, 'request completed');
    assert.equal(line.method, 'GET');
    assert.equal(line.path, `/api/drafts/${JOB_ID}`);
    assert.equal(line.status, 200);
    assert.equal(typeof line.durationMs, 'number');
    assert.equal(typeof line.time, 'string');
  });

  it('does not log health checks', async () => {
    const lines = await captureLogs(async () => {
      await fetch(`${url}/health`);
    });
    assert.deepEqual(lines, []);
  });

  it('logs an unexpected error with the id of the request, after the JSON body is parsed', async () => {
    const { service: failing } = makeService();
    failing.selectResumeFormat = async () => {
      throw new Error('boom-json');
    };
    const app = buildApp({ resumeService: failing, identity: identifyFromHeader, corsOrigin: 'http://localhost:3000', isDatabaseReady: () => true });
    const failingServer = app.listen(0);
    await new Promise((resolve) => failingServer.once('listening', resolve));
    try {
      const lines = await captureLogs(async () => {
        const res = await fetch(`http://127.0.0.1:${(failingServer.address() as AddressInfo).port}/api/drafts/${JOB_ID}/format`, {
          method: 'PUT',
          headers: { 'X-User-Id': SEEKER_ID, 'X-Request-Id': 'gw-boom-1', 'Content-Type': 'application/json' },
          body: JSON.stringify({ format: 'personal' }),
        });
        assert.equal(res.status, 500);
      });
      const line = lines.find((l) => errorMessage(l) === 'boom-json');
      assert.ok(line, `no error line in: ${JSON.stringify(lines)}`);
      assert.equal(line.requestId, 'gw-boom-1');
      assert.equal(line.level, 'error');
    } finally {
      failingServer.close();
    }
  });

  it('allows and exposes the header for browsers (CORS)', async () => {
    const preflight = await fetch(`${url}/api/drafts/${JOB_ID}`, { method: 'OPTIONS' });
    assert.match(preflight.headers.get('access-control-allow-headers')!, /X-Request-Id/);
    assert.equal((await get()).headers.get('access-control-expose-headers'), 'X-Request-Id');
  });
});

describe('x-request-id (gRPC)', () => {
  it('callerMetadata sets the request id next to the token', () => {
    const metadata = callerMetadata({ accessToken: 'token-abc', requestId: 'gw-1' });
    assert.deepEqual(metadata.get('x-request-id'), ['gw-1']);
    assert.deepEqual(metadata.get('authorization'), ['Bearer token-abc']);
    assert.deepEqual(callerMetadata().get('x-request-id'), []);
  });

  it('CandidateProfileClient sends the id to the real gRPC server', async () => {
    type Loaded = { rolefit: { candidateprofile: { v1: { CandidateProfileService: grpc.ServiceClientConstructor } } } };
    const loaded = loadProto('candidate-profile.proto') as unknown as Loaded;
    const seen: grpc.MetadataValue[] = [];
    const upstream = new grpc.Server();
    upstream.addService(loaded.rolefit.candidateprofile.v1.CandidateProfileService.service, {
      GetProfile: (call: grpc.ServerUnaryCall<Msg, Msg>, callback: grpc.sendUnaryData<Msg>) => {
        seen.push(...call.metadata.get('x-request-id'));
        callback({ code: grpc.status.NOT_FOUND, details: 'no profile' });
      },
    });
    const port = await new Promise<number>((resolve, reject) =>
      upstream.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, p) => (err ? reject(err) : resolve(p))),
    );
    try {
      const client = new CandidateProfileClient(`127.0.0.1:${port}`, 2000);
      assert.equal(await client.getProfile(SEEKER_ID, { requestId: 'gw-grpc-1' }), null);
      assert.deepEqual(seen, ['gw-grpc-1']);
    } finally {
      upstream.forceShutdown();
    }
  });

  it('GetApprovedResume logs the id sent by the Application Service', async () => {
    const { service } = makeService();
    await service.generateTailoredResume(seeker, JOB_ID);
    await service.approveResume(seeker, JOB_ID);
    const { server, port } = await startGrpcServer(service, '127.0.0.1', 0);
    type Loaded = { rolefit: { resumepreparation: { v1: { ResumePreparationService: grpc.ServiceClientConstructor } } } };
    const loaded = loadProto('resume-preparation.proto') as unknown as Loaded;
    const client = new loaded.rolefit.resumepreparation.v1.ResumePreparationService(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
    const rpc = (client as unknown as Record<string, Function>).GetApprovedResume.bind(client); // eslint-disable-line @typescript-eslint/no-unsafe-function-type
    const metadata = new grpc.Metadata();
    metadata.set('x-request-id', 'app-svc-7');
    try {
      const lines = await captureLogs(async () => {
        await new Promise((resolve, reject) =>
          rpc({ candidate_id: SEEKER_ID, job_id: JOB_ID }, metadata, (err: grpc.ServiceError | null, res: Msg) => (err ? reject(err) : resolve(res))),
        );
      });
      const line = lines.find((l) => l.requestId === 'app-svc-7');
      assert.ok(line, `no gRPC log line in: ${JSON.stringify(lines)}`);
      assert.equal(line.service, 'resume-preparation');
      assert.equal(line.message, 'rpc completed');
      assert.equal(line.rpc, 'GetApprovedResume');
      assert.equal(line.grpcStatus, 'OK');
      assert.equal(typeof line.durationMs, 'number');
    } finally {
      client.close();
      server.forceShutdown();
    }
  });

  it('GetApprovedResume logs an unexpected error with the id', async () => {
    const { service } = makeService();
    service.getApprovedResume = async () => {
      throw new Error('boom-grpc');
    };
    const { server, port } = await startGrpcServer(service, '127.0.0.1', 0);
    type Loaded = { rolefit: { resumepreparation: { v1: { ResumePreparationService: grpc.ServiceClientConstructor } } } };
    const loaded = loadProto('resume-preparation.proto') as unknown as Loaded;
    const client = new loaded.rolefit.resumepreparation.v1.ResumePreparationService(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
    const rpc = (client as unknown as Record<string, Function>).GetApprovedResume.bind(client); // eslint-disable-line @typescript-eslint/no-unsafe-function-type
    const metadata = new grpc.Metadata();
    metadata.set('x-request-id', 'app-svc-boom');
    try {
      const lines = await captureLogs(async () => {
        await new Promise((resolve) => rpc({ candidate_id: SEEKER_ID, job_id: JOB_ID }, metadata, resolve));
      });
      const line = lines.find((l) => errorMessage(l) === 'boom-grpc');
      assert.ok(line, `no error line in: ${JSON.stringify(lines)}`);
      assert.equal(line.requestId, 'app-svc-boom');
      assert.equal(lines.find((l) => l.rpc === 'GetApprovedResume')?.grpcStatus, 'INTERNAL');
    } finally {
      client.close();
      server.forceShutdown();
    }
  });

  it('names the upstream when it is unavailable, so an outage can be located from the request id', async () => {
    const lines = await captureLogs(async () => {
      await assert.rejects(new JobPostingClient('127.0.0.1:1', 1000).getJob(JOB_ID, { requestId: 'gw-down-1' }));
    });
    const line = lines.find((l) => l.requestId === 'gw-down-1');
    assert.ok(line, `no outage line in: ${JSON.stringify(lines)}`);
    assert.equal(line.level, 'error');
    assert.equal(line.upstream, 'job');
    assert.equal(line.message, 'job service is unavailable');
  });

  it('logs an unexpected upstream error with the id and the upstream name', async () => {
    type Loaded = { rolefit: { candidateprofile: { v1: { CandidateProfileService: grpc.ServiceClientConstructor } } } };
    const loaded = loadProto('candidate-profile.proto') as unknown as Loaded;
    const upstream = new grpc.Server();
    upstream.addService(loaded.rolefit.candidateprofile.v1.CandidateProfileService.service, {
      GetProfile: (_call: grpc.ServerUnaryCall<Msg, Msg>, callback: grpc.sendUnaryData<Msg>) => {
        callback({ code: grpc.status.INTERNAL, details: 'upstream broke' });
      },
    });
    const port = await new Promise<number>((resolve, reject) =>
      upstream.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, p) => (err ? reject(err) : resolve(p))),
    );
    try {
      const lines = await captureLogs(async () => {
        await assert.rejects(new CandidateProfileClient(`127.0.0.1:${port}`, 2000).getProfile(SEEKER_ID, { requestId: 'gw-up-1' }));
      });
      const line = lines.find((l) => l.requestId === 'gw-up-1');
      assert.ok(line, `no upstream error line in: ${JSON.stringify(lines)}`);
      assert.equal(line.upstream, 'profile');
      assert.equal(line.code, grpc.status.INTERNAL);
    } finally {
      upstream.forceShutdown();
    }
  });
});

describe('JSON logger', () => {
  it('logs the AI fallback with the request id and the reason, but no profile content', async () => {
    const adapter = new FallbackTailorAdapter(
      {
        tailorResume: async () => {
          throw new Error('quota exceeded');
        },
      },
      new RuleBasedTailorAdapter(),
    );
    const profile = makeProfile({ name: 'Private Person Name' });
    const lines = await captureLogs(async () => {
      await adapter.tailorResume({ profile, job: makeJob(), requestId: 'gw-ai-1' });
    });
    const line = lines.find((l) => l.requestId === 'gw-ai-1');
    assert.ok(line, `no fallback line in: ${JSON.stringify(lines)}`);
    assert.equal(line.level, 'warn');
    assert.equal(line.reason, 'quota exceeded');
    assert.ok(!JSON.stringify(lines).includes('Private Person Name'));
  });

  it('writes an Error with its name and message instead of an empty object', async () => {
    const lines = await captureLogs(async () => {
      logger.error('It failed', { requestId: 'gw-err-1' }, new TypeError('bad input'));
    });
    assert.equal(lines[0].requestId, 'gw-err-1');
    assert.equal((lines[0].error as { name: string }).name, 'TypeError');
    assert.equal(errorMessage(lines[0]), 'bad input');
  });

  it('never throws on a value JSON cannot represent', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const lines = await captureLogs(async () => {
      logger.error('Circular detail', circular);
      logger.error('BigInt detail', { size: 10n });
    });
    assert.deepEqual(lines.map((l) => l.message), ['Circular detail', 'BigInt detail']);
  });

  it('stays silent under NODE_ENV=test', () => {
    const log = mock.method(console, 'log', () => {});
    try {
      logger.info('should not print');
      assert.equal(log.mock.callCount(), 0);
    } finally {
      log.mock.restore();
    }
  });
});
