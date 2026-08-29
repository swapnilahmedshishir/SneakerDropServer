import { describe, it, before, after } from 'node:test';
import http from 'http';
import app from '../app.js';
import { db } from '../prisma/db.ts';
import { runExpiration } from '../services/expirationService.js';

let server;
let baseUrl;

console.log('[probe] module loaded');

before(async () => {
  console.log('[probe] before: opening server');
  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, resolve);
  });
  baseUrl = `http://localhost:${server.address().port}`;
  console.log(`[probe] before: server open at ${baseUrl}`);
  console.log('[probe] before: runExpiration() start');
  const n = await runExpiration();
  console.log(`[probe] before: runExpiration() done, expired=${n}`);
});

after(async () => {
  console.log('[probe] after: closing server');
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
  console.log('[probe] after: db.close() start');
  await db.close();
  console.log('[probe] after: db closed');
});

describe('PROBE', () => {
  it('trivial', async () => {
    console.log('[probe] it: start');
    const res = await fetch(`${baseUrl}/api/health`);
    console.log(`[probe] it: health=${res.status}`);
    assertTrue();
    console.log('[probe] it: end');
  });
});

function assertTrue() {
  if (1 !== 1) throw new Error('impossible');
}