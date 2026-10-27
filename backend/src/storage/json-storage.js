import { mkdir, readFile, rename, writeFile, copyFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const COLLECTIONS = [
  'usuarios', 'alumnos', 'maestros', 'tutores', 'relaciones_tutores', 'grupos',
  'especialidades', 'semestres', 'materias', 'inscripciones', 'horarios',
  'calendario_escolar', 'jornadas', 'qr_diarios', 'asistencias', 'faltas',
  'retardos', 'listas_asistencia', 'justificaciones', 'permisos', 'notificaciones', 'mensajes',
  'periodos_evaluacion', 'calificaciones', 'boletas', 'avisos_escolares',
  'configuracion', 'auditoria', 'solicitudes_cuenta', 'credenciales_passkey', 'suscripciones_push', 'metadata', 'operaciones'
];

export class JsonStorage {
  #queue = Promise.resolve();
  constructor(directory) { this.directory = path.resolve(directory); }
  file(name) {
    if (!COLLECTIONS.includes(name)) throw new Error('Colección no permitida');
    return path.join(this.directory, `${name}.json`);
  }
  async init() {
    await mkdir(this.directory, { recursive: true });
    for (const name of COLLECTIONS) {
      try { await this.read(name); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const records = name === 'metadata' ? [{ id: 'sistema', schemaVersion: 1, initializedAt: new Date().toISOString() }] : [];
        await this.write(name, records);
      }
    }
    await this.recoverPending();
  }
  async read(name) {
    const raw = await readFile(this.file(name), 'utf8');
    const data = JSON.parse(raw);
    if (!data || data.schemaVersion !== 1 || !Array.isArray(data.records)) throw new Error(`Esquema inválido en ${name}.json`);
    const ids = new Set();
    for (const record of data.records) {
      if (!record || typeof record.id !== 'string' || ids.has(record.id)) throw new Error(`Identificador inválido o duplicado en ${name}.json`);
      ids.add(record.id);
    }
    return data.records;
  }
  async write(name, records) {
    if (!Array.isArray(records)) throw new TypeError('records debe ser una lista');
    const ids = new Set();
    for (const record of records) {
      if (!record || typeof record.id !== 'string' || ids.has(record.id)) throw new Error(`Identificador inválido o duplicado en ${name}.json`);
      ids.add(record.id);
    }
    const target = this.file(name);
    await mkdir(this.directory, { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    const payload = JSON.stringify({ schemaVersion: 1, records }, null, 2) + '\n';
    JSON.parse(payload);
    await writeFile(temp, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try { await rename(temp, target); }
    catch (error) { await rm(temp, { force: true }); throw error; }
  }
  async update(name, mutator) {
    const operation = this.#queue.catch(() => {}).then(async () => {
      const current = await this.read(name);
      const next = await mutator(structuredClone(current));
      await this.write(name, next);
      return next;
    });
    this.#queue = operation;
    try { return await operation; }
    catch (error) { throw error; }
  }
  async transact(patches) {
    const operation = this.#queue.catch(() => {}).then(async () => {
      const resolved=typeof patches==='function'?await patches(name=>this.read(name)):patches;
      const op = { id: randomUUID(), patches:resolved, creadoEn: new Date().toISOString() };
      await this.#applyTransaction(op);
      return op.id;
    });
    this.#queue = operation;
    return operation;
  }
  async #applyTransaction(op) {
    await this.updateJournal(journal => journal.some(item=>item.id===op.id)?journal:[...journal, op]);
    for (const patch of op.patches) await this.#applyPatch(patch);
    await this.updateJournal(journal => journal.filter(item => item.id !== op.id));
  }
  async #applyPatch({ collection, upsert = [], removeIds = [] }) {
    const current = await this.read(collection);
    const removed = new Set(removeIds);
    const next = current.filter(record => !removed.has(record.id));
    for (const incoming of upsert) {
      const index = next.findIndex(record => record.id === incoming.id);
      if (index < 0) next.push(incoming); else next[index] = incoming;
    }
    await this.write(collection, next);
  }
  async updateJournal(mutator) {
    const current = await this.read('operaciones');
    await this.write('operaciones', await mutator(current));
  }
  async recoverPending() {
    for (const op of await this.read('operaciones')) {
      await this.#applyTransaction(op);
    }
  }
  async backup(backupDir) {
    const task=this.#queue.catch(()=>{}).then(async()=>{
      const stamp = new Date().toISOString().replaceAll(':', '-');
      const base=path.resolve(backupDir),destination=path.join(base,stamp),temporary=path.join(base,`.tmp-${randomUUID()}`);
      await mkdir(base,{recursive:true});await mkdir(temporary,{recursive:false});const checksums={};
      try{
        for(const name of COLLECTIONS){const records=await this.read(name);if(!Array.isArray(records))throw new Error(`Copia inválida: ${name}`);const bytes=await readFile(this.file(name));checksums[`${name}.json`]=createHash('sha256').update(bytes).digest('hex');await copyFile(this.file(name),path.join(temporary,`${name}.json`));}
        await writeFile(path.join(temporary,'manifest.json'),JSON.stringify({creadoEn:new Date().toISOString(),schemaVersion:1,sha256:checksums},null,2)+'\n',{flag:'wx'});
        await rename(temporary,destination);return destination;
      }catch(error){await rm(temporary,{recursive:true,force:true});throw error;}
    });this.#queue=task;return task;
  }
  async pruneBackups(backupDir, keep = 30) {
    const dir = path.resolve(backupDir);
    const entries = (await readdir(dir, { withFileTypes: true }).catch(() => []))
      .filter(x => x.isDirectory()).sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries.slice(keep)) await rm(path.join(dir, entry.name), { recursive: true, force: true });
  }
  async verifyBackup(directory){
    const base=path.resolve(directory),manifest=JSON.parse(await readFile(path.join(base,'manifest.json'),'utf8'));
    if(manifest.schemaVersion!==1||!manifest.sha256)throw new Error('Manifiesto de respaldo no válido.');
    const result={};
    for(const name of COLLECTIONS){const filename=`${name}.json`,bytes=await readFile(path.join(base,filename));if(createHash('sha256').update(bytes).digest('hex')!==manifest.sha256[filename])throw new Error(`Checksum incorrecto: ${filename}`);const parsed=JSON.parse(bytes.toString('utf8'));if(parsed.schemaVersion!==1||!Array.isArray(parsed.records))throw new Error(`Esquema inválido: ${filename}`);const ids=new Set();for(const row of parsed.records){if(!row?.id||ids.has(row.id))throw new Error(`ID inválido o duplicado: ${filename}`);ids.add(row.id);}result[name]=parsed.records;}
    return result;
  }
  async restoreBackup(directory,backupDir){
    const records=await this.verifyBackup(directory);const safetyCopy=await this.backup(backupDir);
    const patches=await Promise.all(COLLECTIONS.map(async collection=>{const desired=records[collection],keep=new Set(desired.map(x=>x.id)),current=await this.read(collection);return{collection,upsert:desired,removeIds:current.filter(x=>!keep.has(x.id)).map(x=>x.id)};}));await this.transact(patches);return safetyCopy;
  }
}
