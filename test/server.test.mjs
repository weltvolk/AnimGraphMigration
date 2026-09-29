import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.mjs';
import { writeSyntheticProject, WORKSPACE } from './fixtures/synthetic-project.mjs';

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}

async function localServer(t) {
  const session = await startServer({ port: 0, quiet: true });
  t.after(() => closeServer(session.server));
  return session;
}

function request(session, { route = '/api/inspect', method = 'POST', headers = {}, raw, input, authenticated = true } = {}) {
  const body = raw ?? (input === undefined ? '{}' : JSON.stringify(input));
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      Connection: 'close',
      ...(authenticated ? { Authorization: `Bearer ${session.token}` } : {}),
      ...headers,
    },
  };
  return new Promise((resolve, reject) => {
    const req = http.request(session.origin + route, options, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, headers: response.headers, text, json: () => JSON.parse(text) });
      });
    });
    req.once('error', reject);
    req.end(method === 'GET' ? undefined : body);
  });
}

async function projectFixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'animgraph-server-test-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'source');
  await writeSyntheticProject(root);
  return { root, workspace: WORKSPACE, output: path.join(base, 'converted') };
}

test('server binds IPv4 loopback only and keeps its session token out of HTML', async t => {
  const session = await localServer(t);
  const address = session.server.address();
  assert.equal(address.address, '127.0.0.1');
  assert.equal(address.family, 'IPv4');
  assert.ok(address.port > 0);
  assert.match(session.token, /^[0-9a-f]{64}$/);
  assert.equal(session.url, `${session.origin}/#${session.token}`);
  const response = await request(session, { method: 'GET', route: '/', authenticated: false });
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^text\/html/);
  assert.ok(!response.text.includes(session.token));
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
});

test('API rejects missing, incorrect and wrong-session credentials', async t => {
  const session = await localServer(t);
  const otherSession = await localServer(t);
  const attempts = [
    { authenticated: false },
    { headers: { Authorization: 'Bearer wrong' } },
    { headers: { Authorization: `Bearer ${'0'.repeat(64)}` } },
    { headers: { Authorization: `Bearer ${otherSession.token}` } },
  ];
  for (const options of attempts) {
    const response = await request(session, options);
    assert.equal(response.status, 403);
    assert.match(response.json().error, /session token/);
  }
});

test('Host and Origin restrictions prevent foreign browser contexts and rebinding', async t => {
  const session = await localServer(t);
  const foreignHost = await request(session, { method: 'GET', route: '/', headers: { Host: 'attacker.invalid' } });
  assert.equal(foreignHost.status, 403);
  assert.equal(foreignHost.json().error, 'Unexpected Host');
  const foreignOrigin = await request(session, { headers: { Origin: 'https://attacker.invalid' } });
  assert.equal(foreignOrigin.status, 403);
  assert.equal(foreignOrigin.json().error, 'Unexpected Origin');
  const nullOrigin = await request(session, { headers: { Origin: 'null' } });
  assert.equal(nullOrigin.status, 403);
  const sameOrigin = await request(session, { headers: { Origin: session.origin } });
  assert.equal(sameOrigin.status, 422, 'A valid origin passes authorization and reaches field validation.');
});

test('unsupported routes and methods cannot expose local files or invoke conversion', async t => {
  const session = await localServer(t);
  for (const options of [
    { route: '/src/project.mjs', method: 'GET' },
    { route: '/../../package.json', method: 'GET' },
    { route: '/api/inspect', method: 'GET' },
    { route: '/api/convert', method: 'OPTIONS' },
    { route: '/api/convert', method: 'DELETE' },
    { route: '/api/inspect?extra=1' },
  ]) assert.equal((await request(session, options)).status, 404);
});

test('invalid bodies and unexpected fields fail without holding the operation lock', async t => {
  const session = await localServer(t);
  const project = await projectFixture(t);
  for (const raw of ['{', 'null', '[]', '42', '"text"', '{}', '{"root":42,"workspace":"Example/workspace.aw"}', '{"root":"x","workspace":"y","extra":true}']) {
    const response = await request(session, { raw });
    assert.equal(response.status, 422);
    assert.equal(typeof response.json().error, 'string');
  }
  const wrongType = await request(session, { headers: { 'Content-Type': 'text/plain' } });
  assert.equal(wrongType.status, 415);
  const valid = await request(session, { input: { root: project.root, workspace: project.workspace } });
  assert.equal(valid.status, 200);
  assert.equal(valid.json().assignments, 2);
  assert.deepEqual(await fs.readdir(path.dirname(project.root)), ['source']);
});

test('request size is bounded and the server remains usable after rejection', async t => {
  const session = await localServer(t);
  const response = await request(session, { raw: JSON.stringify({ root: 'x'.repeat(17000), workspace: 'x.aw' }) });
  assert.equal(response.status, 413);
  assert.equal(response.json().error, 'Request too large');
  const next = await request(session);
  assert.equal(next.status, 422);
});

test('authenticated inspect, convert and verify work together on a synthetic project', async t => {
  const session = await localServer(t);
  const project = await projectFixture(t);
  const inspect = await request(session, { input: { root: project.root, workspace: project.workspace } });
  assert.equal(inspect.status, 200);
  const conversion = await request(session, { route: '/api/convert', input: project, headers: { Origin: session.origin } });
  assert.equal(conversion.status, 200);
  assert.equal(conversion.json().sourceUnchanged, true);
  const verify = await request(session, { route: '/api/verify', input: { root: project.output } });
  assert.equal(verify.status, 200);
  assert.equal(verify.json().valid, true);
  const repeat = await request(session, { route: '/api/convert', input: project });
  assert.equal(repeat.status, 422);
  assert.match(repeat.json().error, /already exists/);
});

test('parallel requests are rejected while an authenticated operation body is pending', async t => {
  const session = await localServer(t);
  const pending = http.request(`${session.origin}/api/inspect`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.token}`,
      'Content-Type': 'application/json',
      'Content-Length': '2',
      Connection: 'close',
    },
  });
  const completed = new Promise((resolve, reject) => {
    pending.once('response', response => { response.resume(); response.once('end', resolve); });
    pending.once('error', reject);
  });
  t.after(() => pending.destroy());
  const accepted = new Promise(resolve => session.server.once('request', resolve));
  pending.write('{');
  await accepted;
  const busy = await request(session);
  assert.equal(busy.status, 409);
  pending.end('}');
  await completed;
  const released = await request(session);
  assert.equal(released.status, 422);
});

test('invalid port settings are rejected before binding a listener', async () => {
  for (const port of [-1, 65536, 1.5, 'abc', '', '12x']) {
    await assert.rejects(startServer({ port, quiet: true }), /Port must be/);
  }
});

const nativeApiInputs = {
  '/api/prepare-import': { root: 'prepared', output: 'import', projectTemplate: 'example.gproj', skeletonDefinitions: 'skeletons.anim.xml', gameRoot: 'game' },
  '/api/verify-import': { root: 'prepared', importRoot: 'import' },
  '/api/finalize-import': { root: 'prepared', importRoot: 'import', output: 'final' },
};

test('native API routes retain token/session, Host, Origin and content-type checks', async t => {
  const session = await localServer(t), other = await localServer(t);
  for (const route of Object.keys(nativeApiInputs)) {
    for (const options of [
      { authenticated: false },
      { headers: { Authorization: 'Bearer wrong' } },
      { headers: { Authorization: `Bearer ${other.token}` } },
      { headers: { Host: 'attacker.invalid' } },
      { headers: { Origin: 'https://attacker.invalid' } },
      { headers: { Origin: 'null' } },
    ]) assert.equal((await request(session, { route, ...options })).status, 403, route);
    assert.equal((await request(session, { route, headers: { 'Content-Type': 'text/plain' } })).status, 415);
    const authorized = await request(session, { route, input: {}, headers: { Origin: session.origin } });
    assert.equal(authorized.status, 422, 'Authorized calls reach field validation without importing a native module.');
    assert.match(authorized.json().error, /Invalid request fields/);
  }
});

test('native API routes reject missing fields and do not accept caller-supplied trust/control fields', async t => {
  const session = await localServer(t);
  for (const [route, complete] of Object.entries(nativeApiInputs)) {
    for (const field of Object.keys(complete)) {
      const input = { ...complete };
      delete input[field];
      const response = await request(session, { route, input });
      assert.equal(response.status, 422, `${route} requires ${field}`);
      assert.match(response.json().error, /Invalid request fields/);
    }
    for (const field of ['controls', 'trustedDigests', 'expectedControlSha256', 'controlEvidence', 'runtimeTestEligible', 'nativeImportValidated', 'force', '__proto__']) {
      const input = Object.fromEntries([...Object.entries(complete), [field, 'caller-supplied']]);
      const response = await request(session, { route, input });
      assert.equal(response.status, 422, `${route} rejects ${field}`);
      assert.match(response.json().error, /Invalid request fields/);
    }
  }
});

test('native API routes accept only their exact POST paths', async t => {
  const session = await localServer(t);
  for (const route of Object.keys(nativeApiInputs)) {
    for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS']) assert.equal((await request(session, { route, method })).status, 404);
    assert.equal((await request(session, { route: route + '?force=true' })).status, 404);
    assert.equal((await request(session, { route: route + '/' })).status, 404);
  }
});

test('native API routes share the existing operation lock and release it after rejected fields', async t => {
  const session = await localServer(t);
  const pending = http.request(`${session.origin}/api/prepare-import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json', 'Content-Length': '2', Connection: 'close' },
  });
  const done = new Promise((resolve, reject) => {
    pending.once('response', response => { response.resume(); response.once('end', resolve); });
    pending.once('error', reject);
  });
  t.after(() => pending.destroy());
  const accepted = new Promise(resolve => session.server.once('request', resolve));
  pending.write('{');
  await accepted;
  for (const route of ['/api/inspect', ...Object.keys(nativeApiInputs)]) assert.equal((await request(session, { route })).status, 409);
  pending.end('}');
  await done;
  assert.equal((await request(session, { route: '/api/verify-import' })).status, 422);
});

test('optional assetProfile uses domain errors while default API requests continue working', async t => {
  const session = await localServer(t), project = await projectFixture(t);
  const inspectInput = { root: project.root, workspace: project.workspace };
  const unknown = await request(session, { input: { ...inspectInput, assetProfile: 'unsupported-profile' } });
  assert.equal(unknown.status, 422);
  assert.match(unknown.json().error, /unknown explicit profile/);
  assert.doesNotMatch(unknown.json().error, /Invalid request fields/);
  const ordinary = await request(session, { input: inspectInput });
  assert.equal(ordinary.status, 200);
  assert.equal(ordinary.json().assetMigration, null);
  const conversion = await request(session, { route: '/api/convert', input: project });
  assert.equal(conversion.status, 200);
  assert.equal(conversion.json().assetMigration, null);
  const verification = await request(session, { route: '/api/verify', input: { root: project.output } });
  assert.equal(verification.status, 200);
  assert.equal(verification.json().assetMigration, null);
});
