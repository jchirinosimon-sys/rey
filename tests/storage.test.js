import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { JsonStorage } from '../backend/src/storage/json-storage.js';
import { hashPassword, verifyPassword, createSession, readSession } from '../backend/src/security.js';

test('inicializa colecciones con esquema y rechaza IDs duplicados', async () => {
  const dir = await mkdtemp(path.join(process.cwd(), '.test-data-'));
  try {
    const store = new JsonStorage(dir); await store.init();
    assert.deepEqual(await store.read('alumnos'), []);
    await assert.rejects(store.write('alumnos', [{ id: 'x' }, { id: 'x' }]), /duplicado/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('escrituras concurrentes en un archivo no pierden actualizaciones', async () => {
  const dir = await mkdtemp(path.join(process.cwd(), '.test-data-'));
  try {
    const store = new JsonStorage(dir); await store.init();
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.update('alumnos', rows => [...rows, { id: `a${i}` }])));
    assert.equal((await store.read('alumnos')).length, 20);
    const raw = await readFile(path.join(dir, 'alumnos.json'), 'utf8'); assert.doesNotThrow(() => JSON.parse(raw));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('hash de contraseña y sesión firmada', async () => {
  const hash = await hashPassword('contraseña-de-prueba');
  assert.equal(await verifyPassword('contraseña-de-prueba', hash), true);
  assert.equal(await verifyPassword('incorrecta', hash), false);
  const token = createSession('usuario-1', 'secreto-de-prueba-de-32-caracteres!');
  assert.equal(readSession(token, 'secreto-de-prueba-de-32-caracteres!'), 'usuario-1');
  assert.equal(readSession(`${token}x`, 'secreto-de-prueba-de-32-caracteres!'), null);
});

test('transacción de varias colecciones se recupera tras reiniciar', async () => {
  const dir = await mkdtemp(path.join(process.cwd(), '.test-data-'));
  try {
    const first = new JsonStorage(dir); await first.init();
    const pending = { id:'op-simulada', creadoEn:new Date().toISOString(), patches:[{collection:'asistencias',upsert:[{id:'entrada-1',alumnoId:'alumno-1'}]},{collection:'faltas',upsert:[{id:'falta-1',alumnoId:'alumno-1'}]}] };
    await first.write('operaciones',[pending]);
    const restarted = new JsonStorage(dir); await restarted.init();
    assert.equal((await restarted.read('asistencias'))[0].id,'entrada-1');
    assert.equal((await restarted.read('faltas'))[0].id,'falta-1');
    assert.deepEqual(await restarted.read('operaciones'),[]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('copias verifican checksums y restauran el estado anterior', async () => {
  const dir = await mkdtemp(path.join(process.cwd(), '.test-data-'));
  try {
    const store = new JsonStorage(path.join(dir,'data')); await store.init();
    await store.write('alumnos',[{id:'alumno-1',nombres:'Ana'}]);
    const backup = await store.backup(path.join(dir,'backups'));
    await store.write('alumnos',[{id:'alumno-2',nombres:'Luis'}]);
    await store.restoreBackup(backup,path.join(dir,'backups'));
    assert.equal((await store.read('alumnos'))[0].id,'alumno-1');
    assert.equal((await store.read('alumnos')).length,1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
