import path from 'node:path';
import { JsonStorage } from './json-storage.js';

export async function createStorage(env = process.env) {
  if (env.MONGODB_URI) {
    const { MongoStorage } = await import('./mongo-storage.js');
    return new MongoStorage({ uri: env.MONGODB_URI, database: env.MONGODB_DB }).init();
  }
  if (env.STORAGE_DRIVER === 'mongo') throw new Error('STORAGE_DRIVER=mongo requiere MONGODB_URI.');
  const storage = new JsonStorage(path.resolve(env.DATA_DIR ?? 'backend/data'));
  await storage.init();
  return storage;
}
