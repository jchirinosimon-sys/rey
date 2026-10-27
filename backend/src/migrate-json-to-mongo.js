import path from 'node:path';
import { JsonStorage, COLLECTIONS } from './storage/json-storage.js';
import { createStorage } from './storage/create-storage.js';

if (!process.argv.includes('--confirm')) {
  console.error('Importación detenida. Revisa que DATA_DIR contenga los datos correctos y vuelve a ejecutar con --confirm.');
  process.exit(1);
}
if (!process.env.MONGODB_URI) {
  console.error('Configura MONGODB_URI y MONGODB_DB antes de importar.');
  process.exit(1);
}

const source = new JsonStorage(path.resolve(process.env.DATA_DIR ?? 'backend/data'));
await source.init();
const destination = await createStorage({ ...process.env, STORAGE_DRIVER: 'mongo' });
try {
  const plan = [];
  for (const collection of COLLECTIONS) {
    const records = await source.read(collection);
    const current = await destination.read(collection);
    const canonical = rows => JSON.stringify([...rows].sort((a, b) => a.id.localeCompare(b.id)));
    if (current.length && records.length && canonical(current) !== canonical(records)) {
      throw new Error('La colección ' + collection + ' ya contiene datos distintos en MongoDB; se detuvo la importación completa antes de escribir.');
    }
    plan.push({ collection, records, current });
  }
  for (const { collection, records, current } of plan) {
    if (!records.length || current.length) {
      console.log(collection + ': conservada (' + current.length + ' existente(s), ' + records.length + ' de origen).');
      continue;
    }
    await destination.update(collection, rows => rows.length ? rows : records);
    console.log(collection + ': ' + records.length + ' registro(s) importado(s).');
  }
  console.log('Importación terminada. Comprueba las cuentas y registros desde la aplicación antes de cambiar el tráfico.');
} finally {
  await destination.close();
}
