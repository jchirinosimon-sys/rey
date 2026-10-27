import { createStorage } from './storage/create-storage.js';
import { hashPassword } from './security.js';
import { randomUUID } from 'node:crypto';
const storage = await createStorage(process.env);
const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
if (!email || !password || password.length < 12) {
  console.error('Define BOOTSTRAP_ADMIN_EMAIL y BOOTSTRAP_ADMIN_PASSWORD (mínimo 12 caracteres) antes de crear el administrador.');
  process.exit(1);
}
const users = await storage.read('usuarios');
if (users.some(user => user.email.toLowerCase() === email.toLowerCase())) {
  console.log('El usuario administrador ya existe; no se realizaron cambios.');
} else {
  const passwordHash = await hashPassword(password);
  await storage.update('usuarios', records => [...records, {
    id: randomUUID(), email: email.trim().toLowerCase(), nombre: 'Dirección', rol: 'direccion', activo: true,
    passwordHash, creadoEn: new Date().toISOString()
  }]);
  console.log(`Administrador inicial creado para ${email}. Cambie la contraseña desde un entorno seguro.`);
}
await storage.close?.();
