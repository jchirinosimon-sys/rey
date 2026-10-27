# Arquitectura y estado de la plataforma

## Resumen

Aplicación escolar web en español con cuatro roles (dirección, maestro, alumno y tutor), un backend Node.js y colecciones compartidas JSON. No usa una base de datos tradicional. El frontend es HTML/CSS/JavaScript servido por el backend; los archivos persistentes quedan en una ruta privada fuera del contenido público.

## Estructura actual

```text
frontend/                  Interfaz adaptable, módulos de portal y QR local
backend/src/server.js      API HTTP, autenticación, autorización y tareas
backend/src/security.js    Hash scrypt y sesiones firmadas
backend/src/init.js        Inicialización privada y primer administrador
backend/src/storage/       JSON, journal, transacciones y respaldos
backend/data/              Colecciones privadas (no se sirven al navegador)
backups/                   Copias privadas con manifest SHA-256
tests/                     Pruebas Node.js
docs/                      Arquitectura y operación
```

El servidor concentra temporalmente rutas y reglas de dominio en `server.js`; separar esas capas en controladores/servicios es una mejora de mantenibilidad, no una función pendiente de usuario.

## Colecciones

Cada archivo de datos contiene `{ "schemaVersion": 1, "records": [...] }` e IDs únicos. Se crean durante `npm run init`:

`usuarios`, `solicitudes_cuenta`, `alumnos`, `maestros`, `tutores`, `relaciones_tutores`, `grupos`, `especialidades`, `semestres`, `materias`, `inscripciones`, `horarios`, `calendario_escolar`, `jornadas`, `qr_diarios`, `asistencias`, `listas_asistencia`, `faltas`, `retardos`, `justificaciones`, `notificaciones`, `mensajes`, `periodos_evaluacion`, `calificaciones`, `boletas`, `avisos_escolares`, `configuracion`, `auditoria`, `metadata` y `operaciones`.

`solicitudes_cuenta.json` guarda las solicitudes pendientes con hash de contraseña; tras aprobar/rechazar se elimina el hash de la solicitud. `operaciones.json` es el journal interno de transacciones y recuperación. Las otras colecciones contienen registros de dominio compartidos por toda la escuela; no se crea un archivo por alumno.

## Relaciones clave

- `usuarios.personaId` conecta la cuenta con alumno, maestro o tutor.
- `relaciones_tutores` limita en servidor qué expedientes puede consultar cada tutor.
- `inscripciones` vincula alumno, grupo y ciclo; `horarios` relaciona grupo, maestro y materia.
- Una jornada escolar habilitada origina tokens QR temporales y entradas en `asistencias`.
- Una lista abierta desde horario origina `listas_asistencia` y, al cerrarse, incidencias en `faltas` y `retardos`.
- `calificaciones` se vincula con alumno, materia, maestro y periodo. `boletas` registra qué calificaciones se publicaron.
- `justificaciones` referencia la incidencia que dirección debe resolver. Mensajes internos y notificaciones enlazan destinatario y alumno.

Los endpoints validan las referencias y permisos aplicables. Los tutores y alumnos reciben filtros de pertenencia calculados por el backend, incluso si el cliente altera parámetros.

## Almacenamiento y recuperación

`JsonStorage` es el único componente con acceso a los archivos. Restringe los nombres de colección, valida la envoltura y los IDs, serializa escrituras en una cola de proceso y reemplaza archivos mediante temporal y `rename`. Las operaciones que cambian varias colecciones escriben parches idempotentes en `operaciones.json`, aplican cada parche y limpian el journal. Al iniciar, se recuperan operaciones incompletas.

Los respaldos incluyen manifiesto SHA-256, retención y restauración verificada. Una restauración crea primero una copia de seguridad del estado actual. También hay tarea diaria según zona horaria configurada y respaldos antes de operaciones críticas.

La sincronización solo cubre una instancia del proceso. Ejecuta un solo escritor para cada `DATA_DIR` y usa almacenamiento persistente. JSON vuelve a escribir colecciones completas y tiene límites de rendimiento, memoria y concurrencia; mide el volumen antes de escalar. Una futura migración requiere decisión expresa y no está implementada.

## Seguridad y permisos

Las contraseñas se guardan con scrypt y las sesiones llevan firma HMAC y vencen a las ocho horas. Se incluyen límites de intentos de login en memoria, cabeceras de seguridad y permisos específicos por rol. Las mutaciones se auditan y los hashes, tokens y secretos no se entregan en respuestas. El secreto de sesión se configura por entorno.

La sesión del navegador se guarda actualmente en `localStorage`. Antes de exponer el servicio en Internet, hace falta una revisión de seguridad externa, HTTPS, política operativa, monitoreo, mitigación XSS y migración a cookies seguras y revocables con protección CSRF. El servidor escucha en loopback de forma predeterminada.

## Interfaz y flujos

La interfaz incluye navegación lateral, panel de administración, indicadores y listados con búsqueda y paginación, formularios, estados vacíos, tipografía local y diseño responsive para teléfono y computadora. El formulario público permite pedir una cuenta de alumno, maestro o tutor. La solicitud no habilita acceso: dirección debe vincularla con una ficha existente y aprobarla o rechazarla desde Solicitudes de cuenta. Maestros abren listas desde sus horarios y capturan calificaciones de sus grupos. Alumnos y tutores consultan solo información autorizada.

El QR se construye localmente, rota con un token aleatorio de 128 bits (22 caracteres) cada dos minutos, guarda solo su hash y exige jornada habilitada. El token corto cabe en la capacidad del generador QR local. La lectura usa `BarcodeDetector` si el navegador lo ofrece o permite introducir el texto escaneado. La disponibilidad de cámara depende del navegador y, fuera de localhost, de un contexto seguro. El escaneo por sí mismo no es prueba de presencia física.

Las notificaciones automáticas disponibles son mensajes internos guardados en JSON. No se envía por WhatsApp, SMS o correo.

## Pruebas ejecutadas y límites

`npm test` ejecutado con acceso local de loopback: 7 pruebas pasan. Cubren autenticación y aislamiento familiar, QR local, inicialización/IDs, concurrencia dentro de proceso, hash y sesión firmada, recuperación de transacciones después de reiniciar y checksum/restauración. La prueba de API incluye operaciones de cuentas y flujos HTTP de asistencia, listas, notas, boletas, justificaciones y exportación.

Las pruebas no equivalen a una auditoría ni a un piloto. Falta verificar decodificación QR con cámaras reales, pruebas de carga y fallos físicos de disco, compatibilidad de dispositivos y revisión independiente de seguridad. No se ha generado PDF, configurado proveedor de despliegue ni verificado persistencia en un servidor externo; por tanto, no está desplegada ni aprobada para datos reales.

## Instalación, despliegue y operación

Consulta `README.md` y `.env.example`. Para despliegue hace falta elegir un servidor/VM con filesystem persistente privado, HTTPS, firewall, permisos mínimos, proceso único, monitorización, espacio y copias externas; probar reinicio y restauración antes del piloto. No usar hosting estático ni filesystem efímero. Primero cargar datos ficticios y probar los cuatro roles, restricciones de acceso y recuperación.
