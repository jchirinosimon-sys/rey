import { MongoClient } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { JsonStorage, COLLECTIONS } from './json-storage.js';

function validateRecords(name, records) {
  if (!Array.isArray(records)) throw new TypeError('records debe ser una lista');
  const ids = new Set();
  for (const record of records) {
    if (!record || typeof record.id !== 'string' || ids.has(record.id)) {
      throw new Error('Identificador inválido o duplicado en ' + name + '.');
    }
    ids.add(record.id);
  }
}

export class MongoStorage {
  #queue = Promise.resolve();

  constructor({ uri, database }) {
    if (!uri) throw new Error('Falta MONGODB_URI.');
    this.databaseName = database || 'asistencia';
    this.client = new MongoClient(uri, {
      appName: 'AsistenciaEscolar',
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 10000
    });
  }

  collection(name) {
    if (!COLLECTIONS.includes(name)) throw new Error('Colección no permitida');
    return this.db.collection(name);
  }

  async init() {
    await this.client.connect();
    this.db = this.client.db(this.databaseName);
    await this.db.command({ ping: 1 });
    for (const name of COLLECTIONS) await this.collection(name).createIndex({ id: 1 }, { unique: true, name: 'id_unique' });
    return this;
  }

  async close() {
    await this.client.close();
  }

  async #read(name, session) {
    const rows = await this.collection(name).find({}, { session }).toArray();
    const records = rows.map(({ _id, ...record }) => record);
    validateRecords(name, records);
    return records;
  }

  read(name) {
    return this.#read(name);
  }

  #serialize(task) {
    const operation = this.#queue.catch(() => {}).then(task);
    this.#queue = operation;
    return operation;
  }

  async #replaceState(name, next, session) {
    validateRecords(name, next);
    const collection = this.collection(name);
    const existingIds = (await collection.find({}, { projection: { id: 1 }, session }).toArray()).map(row => row.id);
    const nextIds = new Set(next.map(row => row.id));
    const removed = existingIds.filter(id => !nextIds.has(id));
    if (removed.length) await collection.deleteMany({ id: { $in: removed } }, { session });
    if (next.length) {
      await collection.bulkWrite(next.map(record => ({
        replaceOne: {
          filter: { id: record.id },
          replacement: { ...record, _id: record.id },
          upsert: true
        }
      })), { session, ordered: true });
    }
  }

  update(name, mutator) {
    return this.#serialize(async () => {
      const session = this.client.startSession();
      let result;
      try {
        await session.withTransaction(async () => {
          const current = await this.#read(name, session);
          result = await mutator(structuredClone(current));
          await this.#replaceState(name, result, session);
        });
      } finally {
        await session.endSession();
      }
      return result;
    });
  }

  transact(patches) {
    return this.#serialize(async () => {
      const session = this.client.startSession();
      const transactionId = randomUUID();
      try {
        await session.withTransaction(async () => {
          const read = name => this.#read(name, session);
          const resolved = typeof patches === 'function' ? await patches(read) : patches;
          for (const patch of resolved) {
            const current = await this.#read(patch.collection, session);
            const removed = new Set(patch.removeIds ?? []);
            const next = current.filter(row => !removed.has(row.id));
            for (const incoming of patch.upsert ?? []) {
              const index = next.findIndex(row => row.id === incoming.id);
              if (index < 0) next.push(incoming); else next[index] = incoming;
            }
            await this.#replaceState(patch.collection, next, session);
          }
        }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
        return transactionId;
      } finally {
        await session.endSession();
      }
    });
  }

  async backup(backupDir) {
    const directory = path.resolve(backupDir);
    const snapshotDir = path.join(directory, '.snapshot-' + randomUUID());
    await mkdir(directory, { recursive: true });
    await mkdir(snapshotDir, { recursive: false });
    try {
      const snapshot = new JsonStorage(snapshotDir);
      await snapshot.init();
      for (const name of COLLECTIONS) await snapshot.write(name, await this.read(name));
      return await snapshot.backup(directory);
    } finally {
      await rm(snapshotDir, { recursive: true, force: true });
    }
  }

  async pruneBackups(backupDir, keep = 30) {
    const directory = path.resolve(backupDir);
    const entries = (await readdir(directory, { withFileTypes: true }).catch(() => []))
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries.slice(keep)) await rm(path.join(directory, entry.name), { recursive: true, force: true });
  }

  verifyBackup(directory) {
    return new JsonStorage(directory).verifyBackup(directory);
  }

  async restoreBackup(directory, backupDir) {
    const records = await this.verifyBackup(directory);
    const safetyCopy = await this.backup(backupDir);
    const patches = await Promise.all(COLLECTIONS.map(async collection => {
      const desired = records[collection];
      const keep = new Set(desired.map(row => row.id));
      const current = await this.read(collection);
      return { collection, upsert: desired, removeIds: current.filter(row => !keep.has(row.id)).map(row => row.id) };
    }));
    await this.transact(patches);
    return safetyCopy;
  }
}

