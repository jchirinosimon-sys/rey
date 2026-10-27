import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { JsonStorage } from '../backend/src/storage/json-storage.js';
import { hashPassword } from '../backend/src/security.js';

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('solicitudes, creación y restablecimiento aceptan 5 caracteres y rechazan menos', { timeout: 15000 }, async t => {
  const dir = await mkdtemp(path.join(process.cwd(), '.test-password-'));
  const dataDir = path.join(dir, 'data');
  const backupDir = path.join(dir, 'backups');
  const port = await freePort();
  const storage = new JsonStorage(dataDir);
  await storage.init();
  await storage.write('usuarios', [{
    id: 'admin',
    email: 'admin@test.local',
    nombre: 'Dirección',
    rol: 'direccion',
    activo: true,
    passwordHash: await hashPassword('clave-admin-larga')
  }]);

  const child = spawn(process.execPath, ['backend/src/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      SESSION_SECRET: 'secreto-de-prueba-con-32-caracteres-minimo',
      DATA_DIR: dataDir,
      BACKUP_DIR: backupDir
    },
    stdio: 'ignore'
  });
  t.after(async () => {
    child.kill();
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(resolve, 2000).unref();
    });
    await rm(dir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  let health;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      health = await fetch(`${base}/api/health`);
      if (health.ok) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(health?.status, 200);

  const admin = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@test.local', password: 'clave-admin-larga' })
  });
  assert.equal(admin.status, 200);
  const token = (await admin.json()).token;
  const authHeaders = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const shortRequest = await fetch(`${base}/api/auth/solicitudes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nombre: 'Tutor Uno', email: 'short@test.local', rol: 'tutor', password: '1234' })
  });
  assert.equal(shortRequest.status, 400);
  const validRequest = await fetch(`${base}/api/auth/solicitudes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nombre: 'Tutor Uno', email: 'tutor@test.local', rol: 'tutor', password: '12345' })
  });
  assert.equal(validRequest.status, 202);

  const shortAccount = await fetch(`${base}/api/usuarios`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ nombre: 'Dirección Dos', email: 'short-admin@test.local', rol: 'direccion', password: '1234' })
  });
  assert.equal(shortAccount.status, 400);
  const validAccount = await fetch(`${base}/api/usuarios`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ nombre: 'Dirección Dos', email: 'admin2@test.local', rol: 'direccion', password: 'abcde' })
  });
  assert.equal(validAccount.status, 201);
  const account = await validAccount.json();

  const shortReset = await fetch(`${base}/api/usuarios/${account.id}/password`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ password: '1234' })
  });
  assert.equal(shortReset.status, 400);
  const validReset = await fetch(`${base}/api/usuarios/${account.id}/password`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ password: 'fghij' })
  });
  assert.equal(validReset.status, 200);
});
