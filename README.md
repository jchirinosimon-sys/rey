# Asistencia · Gestión Escolar

Aplicación escolar en español. Puede guardar sus colecciones en archivos JSON para desarrollo local o en MongoDB Atlas para producción; el frontend nunca se conecta directamente a la base de datos.

## Estado

La base incluye login de cuatro roles, solicitudes públicas de cuenta con aprobación de dirección, hashes scrypt, sesiones firmadas, permisos y filtros en servidor, administración de catálogos/cuentas (edición y desactivación), calendario, horarios con detección de cruces, jornadas, QR temporal local, entradas, listas de clase, faltas/retardos, justificaciones, calificaciones, publicación/retiro de boletas, resúmenes internos automáticos, respaldos programados/manuales, restauración con verificación, auditoría, paginación y exportación CSV autorizada. La interfaz incluye navegación, panel de dirección, formularios, filtros familiares, uso de cámara donde el navegador lo soporta y estilos adaptables.

La aplicación incluye pruebas de almacenamiento, autenticación y flujos HTTP. La conexión Atlas se inicializa al arrancar y valida la conexión antes de aceptar tráfico. Antes de utilizar información real, realiza un despliegue de prueba con datos ficticios, comprueba el acceso desde un teléfono y conserva respaldos externos. No se declara aprobada para datos reales hasta completar revisión de seguridad y pruebas de carga y recuperación.

## Tecnologías y carpetas

- Node.js 22+; driver oficial MongoDB y notificaciones Web Push.
- `frontend/`: interfaz HTML, CSS y JavaScript; `qr.js` genera el código QR localmente.
- `backend/src/server.js`: servidor/API, autenticación, permisos, automatización y tareas programadas.
- `backend/src/storage/json-storage.js`: almacenamiento JSON para desarrollo local.
- `backend/src/storage/mongo-storage.js`: almacenamiento MongoDB con documentos individuales, transacciones, índices por ID y respaldos compatibles.
- `backend/src/storage/create-storage.js`: selecciona MongoDB cuando se define MONGODB_URI; localmente conserva JSON si no se configura.
- `backend/src/push.js`: entrega avisos Web Push a los dispositivos que el usuario autorizó.
- `backend/data/`: archivos privados JSON (creados al inicializar, excluidos de Git).
- `backups/`: snapshots privados con manifest SHA-256 y retención.
- `tests/`: pruebas unitarias y prueba de integración del servidor.
- `docs/arquitectura.md`: diseño, contratos de datos y decisiones técnicas.

## Instalación local

1. Copia `.env.example` a `.env`.
2. Cambia `SESSION_SECRET` por un secreto aleatorio de 32 caracteres o más y configura un correo y contraseña inicial para dirección (12 caracteres o más).
3. Ejecuta `npm run init` una vez. El comando crea las colecciones JSON y un usuario administrador; no imprime la contraseña.
4. Ejecuta `npm start` y abre `http://127.0.0.1:3000`.
5. Ejecuta `npm test` para verificar la implementación.

**No abras `frontend/index.html` con Live Server para usar la aplicación.** Live Server solo sirve archivos estáticos y no ejecuta la API de autenticación/escuela. Para usarla completa, inicia `npm start` desde la carpeta del proyecto y abre `http://127.0.0.1:3000`. Las rutas de CSS y JavaScript son relativas para que Live Server pueda encontrar esos recursos si solo quieres previsualizar el diseño; los flujos de acceso y datos requieren el backend.

`HOST` escucha en loopback por defecto. `DATA_DIR` y `BACKUP_DIR` pueden apuntar a volúmenes persistentes privados. No se debe alojar el directorio `backend/data` dentro de una carpeta pública. Mantén una sola instancia escritora para el mismo directorio.

## Archivos de datos

Cada colección tiene forma `{ "schemaVersion": 1, "records": [...] }` e IDs únicos. Los archivos son `usuarios.json`, `solicitudes_cuenta.json`, `alumnos.json`, `maestros.json`, `tutores.json`, `relaciones_tutores.json`, `grupos.json`, `especialidades.json`, `semestres.json`, `materias.json`, `inscripciones.json`, `horarios.json`, `calendario_escolar.json`, `jornadas.json`, `qr_diarios.json`, `asistencias.json`, `listas_asistencia.json`, `faltas.json`, `retardos.json`, `justificaciones.json`, `notificaciones.json`, `mensajes.json`, `periodos_evaluacion.json`, `calificaciones.json`, `boletas.json`, `avisos_escolares.json`, `configuracion.json`, `auditoria.json`, `metadata.json` y `operaciones.json`.

`solicitudes_cuenta.json` contiene solicitudes aún no atendidas y su hash de contraseña, nunca la contraseña original. `operaciones.json` es un journal técnico de recuperación. Las relaciones principales usan IDs: cuentas/personas, inscripciones/alumno/grupo, horarios/maestro/grupo/materia, listas/sesiones, incidencias/alumnos y periodo/materia/calificación. Las faltas y retardos creados al cerrar una lista contienen snapshot descriptivo.

## Portales y uso

### Instalar en el teléfono

La interfaz incluye un manifiesto PWA, iconos de 192 y 512 px y un service worker para que Chrome pueda ofrecer **Instalar** o **Crear acceso directo**. Al iniciar la app instalada aparece una animación breve con la marca Asistencia. El service worker conserva únicamente los archivos públicos de la interfaz y los actualiza desde la red; nunca guarda en caché las respuestas de `/api/` ni los datos institucionales. En Android, abre la URL HTTPS del servicio en Chrome y usa el menú ⋮ → **Instalar aplicación** o **Añadir a pantalla de inicio**. También aparece el botón **Instalar Asistencia** cuando Chrome informa que la instalación está disponible. Después de subir estos archivos al repositorio y esperar el despliegue de Render, recarga la página para que Chrome detecte el manifiesto.

### Dirección

Desde el menú lateral puede revisar solicitudes de cuenta, aprobarlas vinculándolas a un expediente ya existente o rechazarlas; también puede crear cuentas directamente, alumnos, maestros, tutores, grupos, especialidades, semestres, materias, inscripciones, horarios, calendario y periodos. Puede consultar registros, desactivar/reactivar entradas, habilitar jornadas, renovar QR, publicar boletas y gestionar respaldos. Los formularios de relaciones y horarios vinculan por ID. El servidor verifica las referencias y detecta cruces de maestro, grupo o aula.

Para abrir QR, registra primero la fecha en Calendario con tipo `lectivo` o `jornada_especial`, habilita la jornada y pulsa **Generar código**. Se muestra un código numérico de cinco cifras y un QR escaneable que abre un enlace de esta aplicación. El generador usa una matriz QR compacta para facilitar el enfoque. El servidor guarda un HMAC del código, lo acepta durante diez minutos y limita los intentos incorrectos a diez por cuenta cada quince minutos. Rota automáticamente antes de vencer mientras la vista QR esté abierta. El alumno puede escanearlo con el lector interno o con la cámara normal del teléfono; al abrir el enlace, Asistencia conserva el código de forma temporal y registra la entrada tras iniciar sesión. El código se elimina de la barra de dirección y la API comprueba identidad, jornada, hora, duplicados y vigencia. Si no puede escanearlo, puede escribir las cinco cifras. Un QR compartido no acredita presencia física; la institución debe considerar una validación presencial adicional.

### Maestro

Su horario muestra el botón para abrir una lista en la sesión del día. Los alumnos inscritos comienzan pendientes. Antes del cierre se asigna a cada alumno presente, retardo o ausente; el cierre genera la lista, faltas y retardos usando una operación recuperable.

El maestro captura notas dentro de sus grupos y materias asignados. Dirección publica boletas; alumno y tutor sólo ven calificaciones referenciadas por boletas publicadas.

### Alumno y tutor

El alumno consulta su perfil, horario, entradas, faltas/retardos, calificaciones publicadas, mensajes y avisos. El tutor ve exclusivamente alumnos con relación activa; cuando tiene varios puede seleccionar el expediente. El filtro familiar se aplica en el servidor aunque el cliente altere los parámetros.

Las notificaciones automáticas son mensajes internos guardados en JSON; no se simulan envíos por WhatsApp, SMS o correo.

## API implementada

- `GET /api/health`
- `POST /api/auth/login`, `GET /api/auth/me`
- `POST /api/auth/solicitudes` (solicitudes públicas; acceso pendiente de aprobación de dirección)
- `GET /api/solicitudes_cuenta`, `POST /api/solicitudes_cuenta/:id/resolver` (solo dirección)
- `GET /api/dashboard`, `GET /api/perfil`, `GET /api/mis-alumnos`
- `GET /api/:coleccion` aplica permisos y filtros del usuario
- `POST /api/usuarios` crea una cuenta vinculada y almacena únicamente el hash de contraseña
- `POST /api/:coleccion` crea catálogos autorizados; `PATCH /api/:coleccion/:id/estado` desactiva/reactiva
- `POST /api/jornadas`, `POST /api/jornadas/:id/cerrar`
- `POST /api/qr_diarios/renovar`, `POST /api/asistencias/registrar`
- `POST /api/listas_asistencia`, `POST /api/listas_asistencia/:id/cerrar`
- `POST /api/calificaciones`, `POST /api/boletas/publicar`, `POST /api/boletas/:id/retirar`
- `POST /api/justificaciones`, `POST /api/justificaciones/:id/resolver`
- `PUT /api/configuracion`
- `GET /api/exportar/:coleccion.csv` (sólo categorías autorizadas, filtros por usuario y auditoría)
- `GET/POST /api/backups`, `POST /api/backups/restaurar`

Todas las mutaciones requieren un usuario autorizado. El backend define nombres de archivo permitidos; el cliente no puede enviar rutas locales.

## Integridad, seguridad y respaldo

Una cola global de proceso serializa las actualizaciones. Los cambios de una colección se escriben a un temporal y se reemplazan con `rename`. Operaciones que afectan varias colecciones anotan primero parches idempotentes en `operaciones.json`, aplican todos los archivos y eliminan el journal; al iniciar, los journals pendientes se reconcilian. Sigue siendo necesario ejecutar una sola instancia porque el bloqueo no coordina procesos/servidores independientes.

Contraseñas usan scrypt. Sesiones HMAC expiran después de ocho horas; los intentos de login se limitan por IP en memoria. `auditoria.json` guarda el correo, resultado y fecha de cada intento de acceso (máximo 5000 registros); nunca guarda las contraseñas enviadas. Se activan CSP, `nosniff`, `frame-ancestors`, referrer y permisos de cámara limitados. El token se guarda en `localStorage`; por eso no se debe desplegar en Internet hasta completar revisión XSS y migrar a cookies seguras/revocables, HTTPS, políticas operativas y monitoreo.

Se genera un backup diario a las 02:00 de la zona configurada (por defecto `America/Guatemala`), se conserva una ventana de 30 copias y se crea uno antes de acciones críticas. Desde Administración → Copias de seguridad se puede crear o restaurar. Cada copia tiene manifiesto SHA-256 y se verifica íntegramente antes de restaurar; antes de la restauración se crea otra copia del estado actual. Conserva una copia externa al servidor para protegerse de fallos del disco.

El modo JSON reescribe colecciones completas y está pensado para desarrollo local. En producción, MongoDB usa transacciones para operaciones relacionadas; conserva una sola instancia de la aplicación hasta verificar el comportamiento de concurrencia y carga.

## Conectar MongoDB Atlas

La aplicación utiliza la misma interfaz de almacenamiento con JSON local o MongoDB Atlas. Cuando existe MONGODB_URI, el backend usa MongoDB; el navegador nunca recibe la URI ni se conecta directamente.

1. Cambia la contraseña que quedó expuesta en la captura y crea/usa un usuario de base de datos dedicado a la aplicación. Dale readWrite únicamente sobre la base asistencia; no uses el rol de escritura para todas las bases.
2. En Atlas → Network Access autoriza las direcciones de salida del servicio de Render. Para desarrollo local agrega también la IP pública de tu computadora. No abras el acceso a cualquier dirección.
3. En Atlas → Connect → Drivers copia la URI de Node.js. Usa una contraseña nueva, larga y distinta de la contraseña de tu cuenta de Atlas. Codifica los caracteres especiales de la contraseña para la URI.
4. En Render → servicio web → Environment agrega STORAGE_DRIVER=mongo, MONGODB_URI con la URI completa, MONGODB_DB=asistencia y WEB_ORIGIN con el origen HTTPS exacto, por ejemplo `https://tu-servicio.onrender.com` (sin ruta). Mantén SESSION_SECRET y las demás variables actuales. No guardes la URI en frontend/, GitHub ni en mensajes.
5. Después del despliegue, revisa los logs: el servidor verifica la conexión con ping y crea las colecciones e índices requeridos. Si la conexión falla, comprueba la lista IP de Atlas, la URI y el usuario de base de datos.

Para usar Atlas en desarrollo local, agrega las mismas variables en .env; el archivo está excluido de Git. Para regresar a JSON local, quita MONGODB_URI o define STORAGE_DRIVER=json.

### Importar datos JSON

La migración no se ejecuta automáticamente. Primero respalda la carpeta backend/data y confirma que contiene los registros que quieres conservar. Configura la URI de Atlas en .env y ejecuta npm run migrate:json -- --confirm. El importador solo escribe en colecciones vacías y permite volver a ejecutar una importación ya coincidente; si encuentra datos distintos en MongoDB, se detiene para evitar sobrescribirlos. Para la base actual de Render, prepara una exportación desde el entorno que tenga acceso a esos datos; los JSON locales pueden no contener los registros de producción.

Los backups de MongoDB se exportan al formato JSON privado existente y se pueden verificar/restaurar desde el panel. En Render, la carpeta de backups local puede ser efímera; conserva una copia externa y prueba la restauración antes de depender de ella.

## Acceso y notificaciones

Las cuentas inician sesión con correo y contraseña. El registro de entrada se realiza con el QR o el código temporal de cinco números, sujeto a que exista una jornada habilitada y dentro del horario configurado.

Para notificaciones push, genera un par VAPID una sola vez con `npx web-push generate-vapid-keys`. En Render configura `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` y `VAPID_SUBJECT` (por ejemplo, `mailto:admin@escuela.local`). No publiques la clave privada. Cada persona debe pulsar **Activar notificaciones** y aceptar el permiso del navegador en cada teléfono. Si no lo activa, el mensaje se guarda en la bandeja interna, pero el navegador no mostrará una notificación fuera de la página. Web Push requiere HTTPS y puede depender de las restricciones de energía/notificaciones del teléfono.

## Pruebas y pendientes de despliegue

La suite automatizada comprueba esquema e IDs, concurrencia dentro del proceso, hashes y sesiones, recuperación después de reinicio, checksum/restauración y los flujos HTTP de cuentas, aislamiento familiar, listas, calificaciones, boletas, QR y duplicados. Deben añadirse pruebas de carga, QR con cámaras/dispositivos reales, fallos de disco, horarios históricos, exportaciones y pilotaje con datos ficticios.

Para desplegar en Render con Atlas, configura primero las variables privadas indicadas arriba y la lista IP de Atlas; luego publica los cambios y revisa los logs del nuevo despliegue. Configura HTTPS, monitoreo y copias externas. Render puede reiniciar o reemplazar el filesystem local, por lo que la base de producción debe ser Atlas y los respaldos no deben depender solo de la carpeta local del servicio. Mantén una sola instancia hasta verificar concurrencia, carga y restauración.
