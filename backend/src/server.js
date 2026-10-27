import http from 'node:http';
import path from 'node:path';
import { readFile, stat, readdir } from 'node:fs/promises';
import { randomUUID, randomInt, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { COLLECTIONS } from './storage/json-storage.js';
import { createStorage } from './storage/create-storage.js';
import { createSession, readSession, verifyPassword, hashPassword } from './security.js';
import { sendPushNotifications } from './push.js';

const env = process.env;
const port = Number(env.PORT ?? 3000);
const secret = env.SESSION_SECRET;
if (!secret || secret.length < 32) throw new Error('Falta SESSION_SECRET o tiene menos de 32 caracteres. Copia .env.example a .env, configura SESSION_SECRET y vuelve a ejecutar npm start.');
const root = path.resolve('frontend');
const storage = await createStorage(env);
const backupDir=path.resolve(env.BACKUP_DIR??'backups');
const roles = ['direccion', 'maestro', 'alumno', 'tutor'];
const loginFailures=new Map();
const signupFailures=new Map();
const attendanceFailures=new Map();
const createCollections = ['alumnos','maestros','tutores','relaciones_tutores','grupos','especialidades','semestres','materias','inscripciones','avisos_escolares','horarios','calendario_escolar','periodos_evaluacion'];
const securityHeaders={'x-content-type-options':'nosniff','x-frame-options':'DENY','referrer-policy':'no-referrer','content-security-policy':"default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; media-src 'self' blob:; form-action 'self'",'permissions-policy':'camera=(self), microphone=(), geolocation=()'};
const json = (res, status, value, headers={}) => { res.writeHead(status, { ...securityHeaders,...headers,'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
const todayAt = (zone='America/Guatemala') => new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const fail = (status,message) => Object.assign(new Error(message),{status});
const safeEqual = (a,b) => { const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y); };
const hashQrToken = token => token.length===5 ? createHmac('sha256',secret).update(token).digest('hex') : createHash('sha256').update(token).digest('hex');
const normalizeAreaName=value=>String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().replace(/\s+/g,' ').toLocaleLowerCase('es');
function validateFields(collection, record){
  const required={alumnos:['nombres','apellidos','matricula'],maestros:['nombres','apellidos'],tutores:['nombres','apellidos'],relaciones_tutores:['tutorId','alumnoId','parentesco'],grupos:['nombre','ciclo'],especialidades:['nombre'],semestres:['nombre'],materias:['nombre'],inscripciones:['alumnoId','grupoId','ciclo'],avisos_escolares:['titulo','contenido'],horarios:['diaSemana','horaInicio','horaFin','materiaId','maestroId','grupoId'],calendario_escolar:['fecha','tipo'],periodos_evaluacion:['nombre','iniciaEn','terminaEn']}[collection]??[];
  for(const key of required)if(record[key]===undefined||record[key]===null||record[key]==='')throw fail(400,`El campo ${key} es obligatorio.`);
  if(collection==='alumnos'&&String(record.matricula).length>40)throw fail(400,'La matrícula no puede exceder 40 caracteres.');
  if(collection==='horarios'&&(!/^([01]\d|2[0-3]):[0-5]\d$/.test(record.horaInicio)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(record.horaFin)||record.horaInicio>=record.horaFin||!Number.isInteger(Number(record.diaSemana))||Number(record.diaSemana)<0||Number(record.diaSemana)>6))throw fail(400,'El horario debe indicar día de 0 a 6 y horas válidas.');
  if(collection==='calendario_escolar'&&!/^\d{4}-\d{2}-\d{2}$/.test(record.fecha))throw fail(400,'La fecha debe usar el formato AAAA-MM-DD.');
  if(collection==='calendario_escolar'&&!['lectivo','clases','festivo','suspension','sin_clases','evento','evaluacion','jornada_especial'].includes(String(record.tipo).toLowerCase()))throw fail(400,'El tipo de día del calendario no es válido.');
  if(collection==='relaciones_tutores'&&typeof record.activa==='undefined')record.activa=true;
  if(collection==='inscripciones'&&typeof record.estado==='undefined')record.estado='activa';
  if(collection==='alumnos'||collection==='maestros'||collection==='tutores'||collection==='grupos'||collection==='especialidades'||collection==='semestres'||collection==='materias')if(typeof record.activo==='undefined')record.activo=true;
  if(collection==='periodos_evaluacion'&&record.iniciaEn>record.terminaEn)throw fail(400,'El periodo debe terminar después de su fecha de inicio.');
}
async function authorizedRecords(collection,user,selectedStudentId=null){
  const records=await storage.read(collection);
  if(user.rol==='direccion')return collection==='usuarios'?records.map(({passwordHash,...safe})=>safe):records;
  if(collection==='avisos_escolares')return records.filter(x=>x.publicado===true&&(!x.audiencia||x.audiencia==='usuarios'||x.audiencia===user.rol));
  if(user.rol==='alumno'){
    if(collection==='permisos')return records.filter(x=>x.alumnoId===user.personaId);
    if(collection==='mensajes')return records.filter(x=>x.destinatarioUsuarioId===user.id);
    if(collection==='boletas')return records.filter(x=>x.alumnoId===user.personaId&&x.publicada===true);
    if(collection==='calificaciones'){const ids=new Set((await storage.read('boletas')).filter(x=>x.alumnoId===user.personaId&&x.publicada).flatMap(x=>x.referenciasCalificacionIds??[]));return records.filter(x=>x.alumnoId===user.personaId&&ids.has(x.id));}
    if(collection==='horarios'){
      const ins=(await storage.read('inscripciones')).filter(x=>x.alumnoId===user.personaId&&x.estado==='activa');const groups=new Set(ins.map(x=>x.grupoId));return records.filter(x=>x.activo!==false&&groups.has(x.grupoId));
    }
    return records.filter(x=>x.alumnoId===user.personaId);
  }
  if(user.rol==='tutor'){
    const links=(await storage.read('relaciones_tutores')).filter(x=>x.tutorId===user.personaId&&x.activa);
    const ids=new Set(links.map(x=>x.alumnoId));if(selectedStudentId&&ids.has(selectedStudentId)){ids.clear();ids.add(selectedStudentId);}
    if(collection==='permisos')return records.filter(x=>ids.has(x.alumnoId));
    if(collection==='boletas')return records.filter(x=>ids.has(x.alumnoId)&&x.publicada===true);
    if(collection==='calificaciones'){const published=new Set((await storage.read('boletas')).filter(x=>ids.has(x.alumnoId)&&x.publicada).flatMap(x=>x.referenciasCalificacionIds??[]));return records.filter(x=>ids.has(x.alumnoId)&&published.has(x.id));}
    if(collection==='mensajes')return records.filter(x=>x.destinatarioUsuarioId===user.id);
    if(['asistencias','faltas','retardos','justificaciones'].includes(collection))return records.filter(x=>ids.has(x.alumnoId)&&(!x.tutorId||x.tutorId===user.personaId));
    if(collection==='horarios'){
      const ins=(await storage.read('inscripciones')).filter(x=>ids.has(x.alumnoId)&&x.estado==='activa');const groups=new Set(ins.map(x=>x.grupoId));return records.filter(x=>x.activo!==false&&groups.has(x.grupoId));
    }
    return [];
  }
  if(user.rol==='maestro'){
    if(collection==='mensajes')return records.filter(x=>x.destinatarioUsuarioId===user.id);
    if(['horarios','listas_asistencia','faltas','retardos','calificaciones'].includes(collection))return records.filter(x=>x.activo!==false&&x.maestroId===user.personaId);
    return [];
  }
  return [];
}
async function body(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 4_000_000) throw Object.assign(new Error('Solicitud demasiado grande'), { status: 413 }); }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw Object.assign(new Error('JSON inválido'), { status: 400 }); }
}
async function currentUser(req) {
  const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
  const id = readSession(token, secret);
  if (!id) return null;
  return (await storage.read('usuarios')).find(u => u.id === id && u.activo) ?? null;
}
async function audit(user, accion, entidad) {
  await storage.update('auditoria', rows => [...rows, { id: randomUUID(), usuarioId: user.id, accion, entidad, creadoEn: new Date().toISOString() }]);
}
async function auditLogin(email, user, resultado) {
  const record = { id: randomUUID(), usuarioId: user?.id ?? null, accion: resultado === 'correcto' ? 'inicio_sesion_correcto' : 'inicio_sesion_fallido', entidad: 'autenticacion', email: email.slice(0, 254), resultado, creadoEn: new Date().toISOString() };
  await storage.update('auditoria', rows => [...rows, record].slice(-5000));
}
function timeAt(date,zone){const parts=new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date);return `${parts.find(x=>x.type==='hour').value}:${parts.find(x=>x.type==='minute').value}`;}
async function generateDailyMessages(date=todayAt()){
  const [links,students,faults,delays,justifications,notifications,accounts]=await Promise.all(['relaciones_tutores','alumnos','faltas','retardos','justificaciones','notificaciones','usuarios'].map(name=>storage.read(name)));
  const existing=new Set(notifications.map(x=>x.claveIdempotencia));const newNotifications=[],newMessages=[];
  for(const link of links.filter(x=>x.activa)){
    const student=students.find(x=>x.id===link.alumnoId);if(!student)continue;
    const absent=faults.filter(x=>x.alumnoId===student.id&&x.fecha===date&&x.estado==='confirmada');const late=delays.filter(x=>x.alumnoId===student.id&&x.fecha===date&&x.estado!=='anulado');if(!absent.length&&!late.length)continue;
    const key=`resumen:${date}:${link.tutorId}:${student.id}`;if(existing.has(key))continue;
    const tutorUser=accounts.find(x=>x.rol==='tutor'&&x.personaId===link.tutorId&&x.activo);if(!tutorUser)continue;
    const subject=[student.nombres,student.apellidos].filter(Boolean).join(' ');const subjects=absent.map(x=>x.materiaNombre??x.materiaSnapshot??x.materiaId).filter(Boolean);const just=justifications.filter(x=>x.alumnoId===student.id&&absent.some(f=>f.id===x.registroId));
    const text=`Resumen de ${date}: ${subject}. Faltó a ${absent.length} clase(s)${subjects.length?`: ${subjects.join(', ')}`:''}. Retardos registrados: ${late.length}. Justificaciones: ${just.length?just.map(x=>x.estado).join(', '):'sin solicitudes registradas'}.`;
    const notification={id:randomUUID(),claveIdempotencia:key,tutorId:link.tutorId,alumnoId:student.id,estado:'generada',creadaEn:new Date().toISOString()};
    newNotifications.push(notification);newMessages.push({id:randomUUID(),notificacionId:notification.id,destinatarioUsuarioId:tutorUser.id,tutorId:link.tutorId,alumnoId:student.id,asunto:`Resumen escolar · ${subject}`,contenido:text,creadoEn:new Date().toISOString(),leidoEn:null});existing.add(key);
  }
  if(newNotifications.length)await storage.transact([{collection:'notificaciones',upsert:newNotifications},{collection:'mensajes',upsert:newMessages}]);
  return newNotifications.length;
}
let schedulerBusy=false;
async function notifyPublishedAnnouncement(announcement) {
  const audience=announcement.audiencia??'usuarios';const recipients=(await storage.read('usuarios')).filter(account=>account.activo&&(audience==='usuarios'||account.rol===audience));
  return sendPushNotifications(storage,recipients.map(account=>account.id),{id:announcement.id,asunto:announcement.titulo,tipo:'aviso'},env);
}
async function notifyTutorsOfStudentEvent(studentId,event){
  try{
    const [links,students,accounts,subjects]=await Promise.all(['relaciones_tutores','alumnos','usuarios','materias'].map(name=>storage.read(name)));
    const student=students.find(item=>item.id===studentId);if(!student)return;
    const tutorIds=new Set(links.filter(link=>link.alumnoId===studentId&&link.activa===true).map(link=>link.tutorId));if(!tutorIds.size)return;
    const tutors=accounts.filter(account=>account.activo&&account.rol==='tutor'&&tutorIds.has(account.personaId));if(!tutors.length)return;
    const name=[student.nombres,student.apellidos].filter(Boolean).join(' ')||student.nombre||'El alumno';const when=new Date(event.at??Date.now()).toLocaleString('es-GT',{timeZone:'America/Guatemala',dateStyle:'short',timeStyle:'short'});
    const title=event.tipo==='llegada'?'Llegada a la escuela':'Falta registrada';const materia=subjects.find(item=>item.id===event.materiaNombre)?.nombre??event.materiaNombre??'una clase';
    const content=event.tipo==='llegada'?name+' registró su entrada a la escuela el '+when+'.':name+' tiene una falta registrada en '+materia+' el '+when+'.';
    let created=[];
    await storage.update('mensajes',rows=>{created=tutors.filter(account=>!rows.some(row=>row.destinatarioUsuarioId===account.id&&row.eventoOrigenId===event.id)).map(account=>({id:randomUUID(),destinatarioUsuarioId:account.id,destinatarioNombre:account.nombre,tutorId:account.personaId,alumnoId:student.id,tipoEvento:event.tipo,eventoOrigenId:event.id,alcance:'evento_escolar',asunto:title,contenido,creadoEn:new Date().toISOString(),leidoEn:null}));return created.length?[...rows,...created]:rows;});
    await Promise.all(created.map(async message=>{try{await sendPushNotifications(storage,[message.destinatarioUsuarioId],{id:message.id,asunto:title,detalle:content,tipo:event.tipo},env)}catch(error){console.error('No se pudo enviar el aviso al tutor:',error.message)}}));
  }catch(error){console.error('No se pudo guardar el aviso del tutor:',error.message)}
}
async function runScheduledJobs(){if(schedulerBusy)return;schedulerBusy=true;try{
  const settings=(await storage.read('configuracion'))[0]??{},zone=settings.zonaHoraria??'America/Guatemala',today=todayAt(zone),summaryAt=settings.horaResumenDiario??'17:00';
  const prior=new Date(`${today}T12:00:00Z`);prior.setUTCDate(prior.getUTCDate()-1);await generateDailyMessages(prior.toISOString().slice(0,10));
  if(timeAt(new Date(),zone)>=summaryAt)await generateDailyMessages(today);
  if(timeAt(new Date(),zone)==='02:00'){
    const dirs=await readdir(backupDir,{withFileTypes:true}).catch(()=>[]);const date=new Date().toISOString().slice(0,10);
    if(!dirs.some(x=>x.isDirectory()&&x.name.startsWith(date))){await storage.backup(backupDir);await storage.pruneBackups(backupDir,Number(settings.retencionBackups??30));}
  }
}catch(error){console.error('Tarea programada falló:',error.message);}finally{schedulerBusy=false;}}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { estado: 'disponible' });
    if (req.method === 'GET' && url.pathname === '/api/auth/especialidades') return json(res,200,(await storage.read('especialidades')).filter(x=>x.activo!==false).map(({id,nombre})=>({id,nombre})));
    if (req.method === 'POST' && url.pathname === '/api/auth/solicitudes') {
      const ip=req.socket.remoteAddress??'local',now=Date.now(),attempts=signupFailures.get(ip);if(attempts&&attempts.until>now&&attempts.count>=5)return json(res,429,{error:'Se alcanzó el límite de solicitudes. Intenta de nuevo más tarde.'});if(!attempts||attempts.until<=now)signupFailures.set(ip,{count:0,until:now+15*60_000});
      const input=await body(req),nombre=typeof input.nombre==='string'?input.nombre.trim():'',email=typeof input.email==='string'?input.email.trim().toLowerCase():'',password=input.password,rolSolicitado=input.rol,matricula=typeof input.matricula==='string'?input.matricula.trim():'';
      if(nombre.length<2||nombre.length>120||!/^\S+@\S+\.\S+$/.test(email)||email.length>254||typeof password!=='string'||password.length<12||password.length>200||!['alumno','maestro','tutor'].includes(rolSolicitado)||(rolSolicitado==='alumno'&&(!matricula||matricula.length>40||typeof input.especialidad!=='string'||!input.especialidad.trim())))return json(res,400,{error:'Completa nombre, correo, tipo de cuenta, matrícula y especialidad si eres alumno, y una contraseña de 12 caracteres o más.'});
      let especialidad=null;if(rolSolicitado==='alumno'){especialidad=(await storage.read('especialidades')).find(x=>x.activo!==false&&normalizeAreaName(x.nombre)===normalizeAreaName(input.especialidad));if(!especialidad)return json(res,400,{error:'La especialidad no coincide con un área activa. Revisa el nombre registrado con la institución.'});}
      const attemptState=signupFailures.get(ip);signupFailures.set(ip,{...attemptState,count:attemptState.count+1});
      const request={id:randomUUID(),nombre,email,rolSolicitado,...(rolSolicitado==='alumno'?{matricula,especialidadId:especialidad.id,especialidadNombre:especialidad.nombre}:{}),passwordHash:await hashPassword(password),estado:'pendiente',creadoEn:new Date().toISOString()};
      await storage.update('solicitudes_cuenta',async rows=>{const accounts=await storage.read('usuarios');if(accounts.some(x=>x.email===email)||rows.some(x=>x.email===email&&x.estado==='pendiente'))throw fail(409,'Ya existe una cuenta o solicitud pendiente con ese correo.');return[...rows,request];});
      return json(res,202,{mensaje:rolSolicitado==='alumno'?'Solicitud recibida. Dirección debe aprobarla; la matrícula se usará para encontrar tu expediente.':'Solicitud recibida. Dirección debe aprobar y vincular tu expediente antes de que puedas iniciar sesión.'});
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const ip=req.socket.remoteAddress??'local',now=Date.now(),entry=loginFailures.get(ip);if(entry&&entry.until>now&&entry.count>=10)return json(res,429,{error:'Demasiados intentos. Espera 15 minutos y vuelve a intentarlo.'});if(entry&&entry.until<=now)loginFailures.delete(ip);
      const input = await body(req);
      if (typeof input.email !== 'string' || typeof input.password !== 'string') return json(res, 400, { error: 'Correo y contraseña son obligatorios.' });
      const email = input.email.trim().toLowerCase();
      const user = (await storage.read('usuarios')).find(u => u.email === email && u.activo);
      if (!user || !(await verifyPassword(input.password, user.passwordHash))) {const state=loginFailures.get(ip);loginFailures.set(ip,{count:state&&state.until>now?state.count+1:1,until:state&&state.until>now?state.until:now+15*60_000});await auditLogin(email,null,'fallido');return json(res, 401, { error: 'Credenciales incorrectas.' });}
      loginFailures.delete(ip);
      await auditLogin(email,user,'correcto');
      return json(res, 200, { token: createSession(user.id, secret), usuario: { id: user.id, nombre: user.nombre, email:user.email, rol: user.rol } });
    }
    const user = await currentUser(req);
    if (req.method.startsWith('GET') && url.pathname === '/api/auth/me') {
      if (!user) return json(res, 401, { error: 'Inicia sesión.' });
      return json(res, 200, { id: user.id, nombre: user.nombre, email:user.email, rol: user.rol });
    }
    if (url.pathname.startsWith('/api/')) {
      if (!user) return json(res, 401, { error: 'Inicia sesión.' });
      if(req.method==='GET'&&url.pathname==='/api/solicitudes_cuenta'){
        if(user.rol!=='direccion')return json(res,403,{error:'Solo dirección puede revisar solicitudes.'});
        const requests=(await storage.read('solicitudes_cuenta')).map(({passwordHash,passkeyCredential,...safe})=>safe);return json(res,200,requests);
      }
      const accountRequestMatch=url.pathname.match(/^\/api\/solicitudes_cuenta\/([^/]+)\/resolver$/);
      if(req.method==='POST'&&accountRequestMatch){
        if(user.rol!=='direccion')return json(res,403,{error:'Solo dirección puede resolver solicitudes.'});
        const input=await body(req);if(!['aprobar','rechazar'].includes(input.decision))return json(res,400,{error:'Selecciona aprobar o rechazar.'});
        let approvedUser=null,resolvedRequest=null;
        await storage.transact(async read=>{
          const requests=await read('solicitudes_cuenta'),request=requests.find(x=>x.id===accountRequestMatch[1]);if(!request||request.estado!=='pendiente')throw fail(409,'La solicitud no existe o ya fue atendida.');
          const {passwordHash,passkeyCredential:_legacyPasskeyCredential,...requestInfo}=request;
          if(input.decision==='rechazar'){resolvedRequest={...requestInfo,estado:'rechazada',resueltaPor:user.id,resueltaEn:new Date().toISOString()};return[{collection:'solicitudes_cuenta',upsert:[resolvedRequest]}];}
          const personCollection={alumno:'alumnos',maestro:'maestros',tutor:'tutores'}[request.rolSolicitado];let personaId=typeof input.personaId==='string'?input.personaId.trim():'';if(request.rolSolicitado==='alumno'){const area=(await read('especialidades')).find(x=>x.id===request.especialidadId&&x.activo!==false);if(!area)throw fail(409,'La especialidad ya no existe o está inactiva. Rechaza la solicitud o reactiva el área.');const matricula=typeof request.matricula==='string'?request.matricula.trim().toLocaleLowerCase('es'):'';const student=(await read('alumnos')).find(x=>String(x.matricula??'').trim().toLocaleLowerCase('es')===matricula&&x.activo!==false);if(!student)throw fail(400,'No existe un alumno activo con esa matrícula. Verifica la matrícula con la institución.');if(student.especialidadId&&student.especialidadId!==request.especialidadId)throw fail(409,'La especialidad de la matrícula no coincide con la indicada en la solicitud.');personaId=student.id;}if(!personaId||!(await read(personCollection)).some(x=>x.id===personaId&&x.activo!==false))throw fail(400,'Dirección debe vincular la solicitud con un expediente activo existente.');
          const accounts=await read('usuarios');if(accounts.some(x=>x.email===request.email))throw fail(409,'Ya existe una cuenta con ese correo.');if(accounts.some(x=>x.rol===request.rolSolicitado&&x.personaId===personaId&&x.activo))throw fail(409,'Ese expediente ya tiene una cuenta activa.');
          approvedUser={id:randomUUID(),email:request.email,nombre:request.nombre,rol:request.rolSolicitado,personaId,activo:true,...(request.rolSolicitado==='alumno'?{especialidadId:request.especialidadId}:{}),passwordHash,creadoEn:new Date().toISOString(),aprobadoPor:user.id};
          resolvedRequest={...requestInfo,estado:'aprobada',usuarioId:approvedUser.id,resueltaPor:user.id,resueltaEn:new Date().toISOString()};
          const patches=[{collection:'usuarios',upsert:[approvedUser]},{collection:'solicitudes_cuenta',upsert:[resolvedRequest]}];
          return patches;
        });
        await audit(user,`solicitud_cuenta_${input.decision}`,accountRequestMatch[1]);
        if(approvedUser){const{passwordHash,...safe}=approvedUser;return json(res,200,{solicitud:resolvedRequest,usuario:safe});}
        return json(res,200,resolvedRequest);
      }
      if (url.pathname === '/api/dashboard' && req.method === 'GET') {
        if (user.rol === 'direccion') {
          const [alumnos, maestros, grupos, asistencias, faltas, retardos, listas, notificaciones, calificaciones, jornadas,periodos] = await Promise.all(['alumnos','maestros','grupos','asistencias','faltas','retardos','listas_asistencia','notificaciones','calificaciones','jornadas','periodos_evaluacion'].map(n => storage.read(n)));
          return json(res, 200, { alumnos: alumnos.filter(x=>x.activo!==false).length, maestros: maestros.filter(x=>x.activo!==false).length, grupos: grupos.filter(x=>x.activo!==false).length, asistencias: asistencias.filter(x=>x.fecha===todayAt()).length, faltas: faltas.filter(x=>x.fecha===todayAt()).length, retardos: retardos.filter(x=>x.fecha===todayAt()).length, listasPendientes: listas.filter(x => x.estado === 'abierta').length, notificacionesPendientes: notificaciones.filter(x => x.estado === 'pendiente').length, calificaciones: calificaciones.length, jornadas:jornadas.filter(x=>x.fecha===todayAt()&&x.estado==='habilitada').length,periodosActivos:periodos.filter(x=>x.estado!=='cerrado').length });
        }
        return json(res, 200, { rol: user.rol, nombre: user.nombre });
      }
      if(req.method==='GET'&&url.pathname==='/api/backups'){
        if(user.rol!=='direccion')return json(res,403,{error:'Solo dirección puede consultar las copias.'});
        const dirs=await readdir(backupDir,{withFileTypes:true}).catch(()=>[]);return json(res,200,dirs.filter(x=>x.isDirectory()&&!x.name.startsWith('.tmp-')).map(x=>({id:x.name})).sort((a,b)=>b.id.localeCompare(a.id)));
      }
      if(req.method==='PUT'&&url.pathname==='/api/configuracion'&&user.rol==='direccion'){
        const input=await body(req),timeZone=input.zonaHoraria??'America/Guatemala';try{new Intl.DateTimeFormat('es',{timeZone}).format(new Date())}catch{return json(res,400,{error:'La zona horaria no es válida.'});}
        const summary=input.horaResumenDiario??'17:00',retention=Number(input.retencionBackups??30),scaleMin=Number(input.escalaMin??0),scaleMax=Number(input.escalaMax??100);if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(summary)||!Number.isInteger(retention)||retention<1||retention>365||!Number.isFinite(scaleMin)||!Number.isFinite(scaleMax)||scaleMin>=scaleMax)return json(res,400,{error:'Hora, retención (1 a 365 días) o escala de calificaciones inválida.'});
        const setting={id:'configuracion-institucional',zonaHoraria:timeZone,horaResumenDiario:summary,retencionBackups:retention,escalaMin:scaleMin,escalaMax:scaleMax,actualizadoEn:new Date().toISOString(),actualizadoPor:user.id};await storage.update('configuracion',()=>[setting]);await audit(user,'actualizar_configuracion',setting.id);return json(res,200,setting);
      }
      if(req.method==='POST'&&url.pathname==='/api/backups'){
        if(user.rol!=='direccion')return json(res,403,{error:'Solo dirección puede crear copias.'});const directory=await storage.backup(backupDir);await storage.pruneBackups(backupDir,30);await audit(user,'crear_respaldo',path.basename(directory));return json(res,201,{id:path.basename(directory)});
      }
      if(req.method==='POST'&&url.pathname==='/api/backups/restaurar'){
        if(user.rol!=='direccion')return json(res,403,{error:'Solo dirección puede restaurar copias.'});const input=await body(req);if(typeof input.id!=='string'||path.basename(input.id)!==input.id||input.id.startsWith('.'))return json(res,400,{error:'Copia seleccionada inválida.'});const source=path.join(backupDir,input.id);const safetyCopy=await storage.restoreBackup(source,backupDir);await audit(user,'restaurar_respaldo',input.id);return json(res,200,{restaurado:input.id,copiaAnterior:path.basename(safetyCopy)});
      }
      if(req.method==='GET'&&url.pathname==='/api/mis-alumnos'){
        if(!['alumno','tutor'].includes(user.rol))return json(res,403,{error:'Este portal no tiene expedientes vinculados.'});const students=await storage.read('alumnos');if(user.rol==='alumno')return json(res,200,students.filter(x=>x.id===user.personaId));const links=(await storage.read('relaciones_tutores')).filter(x=>x.tutorId===user.personaId&&x.activa);const ids=new Set(links.map(x=>x.alumnoId));return json(res,200,students.filter(x=>ids.has(x.id)));
      }
      if(req.method==='GET'&&url.pathname==='/api/mis-vinculos'&&user.rol==='tutor'){
        const [links,students]=await Promise.all([storage.read('relaciones_tutores'),storage.read('alumnos')]);return json(res,200,links.filter(x=>x.tutorId===user.personaId).map(link=>{const student=students.find(x=>x.id===link.alumnoId);return{id:link.id,alumnoNombre:link.alumnoNombreSnapshot??(student?[student.nombres,student.apellidos].filter(Boolean).join(' '):'Alumno no disponible'),matricula:link.matricula??student?.matricula??'',parentesco:link.parentesco,estado:link.activa?'activo':'pendiente de aprobación',activa:Boolean(link.activa)}}));
      }
      if(req.method==='POST'&&url.pathname==='/api/relaciones_tutores/vincular'&&user.rol==='tutor'){
        const input=await body(req),matricula=typeof input.matricula==='string'?input.matricula.trim(): '',parentesco=typeof input.parentesco==='string'?input.parentesco.trim():'';
        if(!matricula||matricula.length>40||!parentesco||parentesco.length>40)return json(res,400,{error:'Escribe la matrícula del alumno y tu parentesco.'});
        const student=(await storage.read('alumnos')).find(x=>x.activo!==false&&String(x.matricula??'').trim().toLocaleLowerCase('es')===matricula.toLocaleLowerCase('es'));if(!student)return json(res,404,{error:'No se encontró un alumno activo con esa matrícula. Verifícala con la institución.'});
        const linked=await storage.read('relaciones_tutores');if(linked.some(x=>x.tutorId===user.personaId&&x.alumnoId===student.id))return json(res,409,{error:'Ya existe una solicitud o vínculo para ese alumno.'});
        const relation={id:randomUUID(),tutorId:user.personaId,alumnoId:student.id,parentesco,activa:false,estado:'pendiente',matricula:student.matricula,alumnoNombreSnapshot:[student.nombres,student.apellidos].filter(Boolean).join(' '),solicitadaPor:user.id,solicitadaEn:new Date().toISOString()};await storage.update('relaciones_tutores',rows=>[...rows,relation]);await audit(user,'solicitar_vinculo_alumno',relation.id);return json(res,202,{mensaje:'Solicitud enviada a Dirección. El expediente aparecerá en tu cuenta cuando aprueben el vínculo.'});
      }
      if((req.method==='GET'||req.method==='PATCH')&&url.pathname==='/api/perfil'){
        if(!['alumno','maestro','tutor'].includes(user.rol))return json(res,403,{error:'El administrador no tiene un perfil académico personal.'});
        const collection={alumno:'alumnos',maestro:'maestros',tutor:'tutores'}[user.rol];
        let profile=(await storage.read(collection)).find(x=>x.id===user.personaId);
        if(!profile)return json(res,404,{error:'No existe una ficha asociada a esta cuenta.'});
        if(req.method==='PATCH'){
          if(user.rol!=='alumno')return json(res,403,{error:'Solo el alumno puede completar sus datos de contacto.'});
          const input=await body(req),allowed=['telefono','correoContacto'];
          if(Object.keys(input).some(key=>!allowed.includes(key)))return json(res,400,{error:'Solo puedes actualizar teléfono y correo de contacto.'});
          const telefono=String(input.telefono??'').trim(),correoContacto=String(input.correoContacto??'').trim().toLowerCase();
          if(telefono.length>30|| (telefono&&!/^\+?[0-9 ()-]{7,30}$/.test(telefono)))return json(res,400,{error:'Escribe un teléfono válido de hasta 30 caracteres.'});
          if(correoContacto.length>254||(correoContacto&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correoContacto)))return json(res,400,{error:'Escribe un correo de contacto válido.'});
          const updated=await storage.update('alumnos',rows=>rows.map(row=>row.id===user.personaId?{...row,telefono,correoContacto,actualizadoEn:new Date().toISOString()}:row));
          profile=updated.find(x=>x.id===user.personaId);await audit(user,'completar_perfil_alumno',user.personaId);
        }
        if(user.rol==='alumno'){
          const [enrollments,groups,areas]=await Promise.all([storage.read('inscripciones'),storage.read('grupos'),storage.read('especialidades')]);
          const enrollment=enrollments.find(x=>x.alumnoId===profile.id&&x.estado==='activa'),group=groups.find(x=>x.id===enrollment?.grupoId),area=areas.find(x=>x.id===(profile.especialidadId??group?.especialidadId??user.especialidadId));
          profile={...profile,correoCuenta:user.email,especialidadNombre:area?.nombre??profile.especialidad??'',grupoNombre:group?.nombre??'',semestre:group?.semestre??'',ciclo:enrollment?.ciclo??group?.ciclo??''};
        }
        return json(res,200,profile);
      }
      const exportMatch=url.pathname.match(/^\/api\/exportar\/([a-z_]+)\.csv$/);
      if(req.method==='GET'&&exportMatch){
        const collection=exportMatch[1],exportable=['alumnos','maestros','tutores','grupos','materias','horarios','asistencias','listas_asistencia','faltas','retardos','justificaciones','calificaciones','boletas','mensajes','avisos_escolares'];if(!exportable.includes(collection))return json(res,403,{error:'Esta categoría no se puede exportar.'});
        let records=await authorizedRecords(collection,user,url.searchParams.get('alumnoId'));for(const key of ['grupoId','materiaId','fecha','estado']){const value=url.searchParams.get(key);if(value)records=records.filter(row=>String(row[key]??'')===value);}if(records.length>50_000)return json(res,413,{error:'Aplica filtros para exportar como máximo 50,000 registros.'});
        const keys=[...new Set(records.flatMap(row=>Object.keys(row)))].filter(key=>!['passwordHash','token','secret','tokenHash'].includes(key));const cell=value=>{let text=typeof value==='object'&&value!==null?JSON.stringify(value):String(value??'');if(/^[=+\-@\t\r]/.test(text))text=`'${text}`;return `"${text.replaceAll('"','""')}"`;};const csv='\uFEFF'+[keys.map(cell).join(','),...records.map(row=>keys.map(key=>cell(row[key])).join(','))].join('\r\n');
        await audit(user,'exportar',collection);res.writeHead(200,{...securityHeaders,'content-type':'text/csv; charset=utf-8','content-disposition':`attachment; filename="${collection}.csv"`,'cache-control':'no-store'});return res.end(csv);
      }
      const deleteMatch=url.pathname.match(/^\/api\/(alumnos|avisos_escolares|mensajes)\/([^/]+)$/);
      if(req.method==='DELETE'&&deleteMatch){
        const [,collection,id]=deleteMatch;let deleted;
        if(collection==='avisos_escolares'||collection==='alumnos'){if(user.rol!=='direccion')return json(res,403,{error:'Solo Dirección puede borrar este registro.'});}
        if(collection==='mensajes'&&user.rol!=='direccion'){const owned=(await storage.read('mensajes')).find(x=>x.id===id&&x.destinatarioUsuarioId===user.id);if(!owned)return json(res,403,{error:'Solo puedes borrar mensajes de tu propia bandeja.'});}
        if(collection==='mensajes'||collection==='avisos_escolares'){
          const item=(await storage.read(collection)).find(x=>x.id===id);if(!item)return json(res,404,{error:'No se encontró el registro.'});
          await storage.transact([{collection,removeIds:[id]}]);deleted=item;
        }else{
          const all=Object.fromEntries(await Promise.all(['alumnos','usuarios','relaciones_tutores','inscripciones','asistencias','faltas','retardos','justificaciones','calificaciones','boletas','notificaciones','mensajes','suscripciones_push','listas_asistencia'].map(async name=>[name,await storage.read(name)])));
          const student=all.alumnos.find(x=>x.id===id);if(!student)return json(res,404,{error:'No se encontró el alumno.'});
          const linkedAccounts=all.usuarios.filter(x=>x.rol==='alumno'&&x.personaId===id),accountIds=new Set(linkedAccounts.map(x=>x.id));
          const links=all.relaciones_tutores.filter(x=>x.alumnoId===id).map(x=>x.id),enrollments=all.inscripciones.filter(x=>x.alumnoId===id).map(x=>x.id);
          const filters={usuarios:x=>accountIds.has(x.id),relaciones_tutores:x=>x.alumnoId===id,inscripciones:x=>x.alumnoId===id,asistencias:x=>x.alumnoId===id,faltas:x=>x.alumnoId===id,retardos:x=>x.alumnoId===id,justificaciones:x=>x.alumnoId===id,calificaciones:x=>x.alumnoId===id,boletas:x=>x.alumnoId===id,notificaciones:x=>x.alumnoId===id||accountIds.has(x.destinatarioUsuarioId),mensajes:x=>x.alumnoId===id||accountIds.has(x.destinatarioUsuarioId),suscripciones_push:x=>accountIds.has(x.usuarioId)};
          const patches=[{collection:'alumnos',removeIds:[id]},...Object.entries(filters).map(([name,predicate])=>({collection:name,removeIds:all[name].filter(predicate).map(x=>x.id)})).filter(x=>x.removeIds.length)];
          const lists=all.listas_asistencia.filter(row=>(row.alumnos??[]).some(member=>member.alumnoId===id)).map(row=>({...row,alumnos:row.alumnos.filter(member=>member.alumnoId!==id)}));if(lists.length)patches.push({collection:'listas_asistencia',upsert:lists});
          await storage.transact(patches);deleted=student;
        }
        await audit(user,'eliminar',collection+':'+id);return json(res,200,{mensaje:collection==='alumnos'?'Alumno y datos relacionados eliminados.':'Registro eliminado.',id:deleted.id});
      }
      const editMatch=url.pathname.match(/^\/api\/([^/]+)\/([^/]+)$/);
      if(req.method==='PATCH'&&editMatch&&user.rol==='direccion'){
        const [,collection,id]=editMatch;if(collection!=='usuarios'&&!createCollections.includes(collection))return json(res,403,{error:'Esta categoría no admite edición desde esta ruta.'});const old=(await storage.read(collection)).find(x=>x.id===id);if(!old)return json(res,404,{error:'Registro no encontrado.'});const input=await body(req);
        const fields={usuarios:['nombre','email'],alumnos:['nombres','apellidos','matricula','fechaNacimiento','activo'],maestros:['nombres','apellidos','numeroEmpleado','correo','activo'],tutores:['nombres','apellidos','correo','telefono','activo'],relaciones_tutores:['tutorId','alumnoId','parentesco','activa'],grupos:['nombre','ciclo','semestreId','especialidadId','semestre','activo'],especialidades:['nombre','clave','activo'],semestres:['nombre','orden','activo'],materias:['nombre','clave','activo'],inscripciones:['alumnoId','grupoId','ciclo','estado'],avisos_escolares:['titulo','contenido','publicado','visibleDesde','visibleHasta','audiencia'],horarios:['diaSemana','horaInicio','horaFin','materiaId','maestroId','grupoId','aula','desde','hasta','activo'],calendario_escolar:['fecha','tipo','descripcion','jornadas','activo'],periodos_evaluacion:['nombre','iniciaEn','terminaEn','estado','escalaMin','escalaMax']}[collection]??[];
        if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!fields.includes(key)))return json(res,400,{error:'Los campos de actualización no son válidos.'});const candidate={...old,...input,actualizadoEn:new Date().toISOString()};if(collection==='usuarios'&&typeof candidate.email==='string')candidate.email=candidate.email.trim().toLowerCase();if(collection==='avisos_escolares'){candidate.audiencia=candidate.audiencia??'usuarios';if(!['usuarios','alumno','tutor','maestro'].includes(candidate.audiencia))return json(res,400,{error:'Selecciona un destinatario válido para el aviso.'});}validateFields(collection,candidate);
        if(collection==='relaciones_tutores'&&(!(await storage.read('tutores')).some(x=>x.id===candidate.tutorId)||!(await storage.read('alumnos')).some(x=>x.id===candidate.alumnoId)))return json(res,400,{error:'El tutor y alumno deben existir.'});
        if(collection==='inscripciones'&&(!(await storage.read('alumnos')).some(x=>x.id===candidate.alumnoId)||!(await storage.read('grupos')).some(x=>x.id===candidate.grupoId)))return json(res,400,{error:'El alumno y grupo deben existir.'});
        if(collection==='grupos'&&candidate.semestreId&&!(await storage.read('semestres')).some(x=>x.id===candidate.semestreId))return json(res,400,{error:'El semestre indicado no existe.'});
        if(collection==='grupos'&&candidate.especialidadId&&!(await storage.read('especialidades')).some(x=>x.id===candidate.especialidadId&&x.activo!==false))return json(res,400,{error:'La especialidad indicada no existe o está inactiva.'});if(collection==='grupos'&&candidate.semestre!==undefined){candidate.semestre=Number(candidate.semestre);if(!Number.isInteger(candidate.semestre)||candidate.semestre<1||candidate.semestre>6)return json(res,400,{error:'El semestre del grupo debe ser un número del 1 al 6.'});}
        if(collection==='usuarios'){if(typeof candidate.nombre!=='string'||!candidate.nombre.trim()||typeof candidate.email!=='string'||!candidate.email.includes('@'))return json(res,400,{error:'Nombre y correo válido son obligatorios.'});candidate.nombre=candidate.nombre.trim();}
        if(collection==='horarios'){
          for(const [name,ref] of [['maestros',candidate.maestroId],['grupos',candidate.grupoId],['materias',candidate.materiaId]])if(!(await storage.read(name)).some(x=>x.id===ref))return json(res,400,{error:`La referencia ${name} no existe.`});
          if((await storage.read('horarios')).some(x=>x.id!==id&&x.activo!==false&&Number(x.diaSemana)===Number(candidate.diaSemana)&&[x.maestroId===candidate.maestroId,x.grupoId===candidate.grupoId,Boolean(candidate.aula&&x.aula===candidate.aula)].some(Boolean)&&candidate.horaInicio<x.horaFin&&candidate.horaFin>x.horaInicio))return json(res,409,{error:'El horario se cruza con otra clase del mismo maestro, grupo o aula.'});candidate.diaSemana=Number(candidate.diaSemana);
        }
        if(['horarios','periodos_evaluacion'].includes(collection))await storage.backup(backupDir);
        const unique=({usuarios:['email'],alumnos:['matricula'],maestros:['numeroEmpleado'],especialidades:['clave'],materias:['clave']}[collection]??[]);const updated=await storage.update(collection,rows=>{if(collection==='especialidades'&&rows.some(row=>row.id!==id&&normalizeAreaName(row.nombre)===normalizeAreaName(candidate.nombre)))throw fail(409,'Ya existe un área con ese nombre, aunque cambien los acentos o las mayúsculas.');if(unique.some(key=>candidate[key]&&rows.some(row=>row.id!==id&&String(row[key]).toLowerCase()===String(candidate[key]).toLowerCase())))throw fail(409,'Ya existe otro registro con ese identificador.');return rows.map(row=>row.id===id?candidate:row);});await audit(user,'editar',`${collection}:${id}`);const edited=updated.find(x=>x.id===id);if(edited.passwordHash){const{passwordHash,...safe}=edited;return json(res,200,safe)}if(collection==='avisos_escolares'&&!old.publicado&&edited.publicado)return json(res,200,{...edited,notificacionesPush:await notifyPublishedAnnouncement(edited)});return json(res,200,edited);
      }
      const passwordMatch=url.pathname.match(/^\/api\/usuarios\/([^/]+)\/password$/);
      if(req.method==='PATCH'&&passwordMatch&&user.rol==='direccion'){
        const input=await body(req);if(typeof input.password!=='string'||input.password.length<12)return json(res,400,{error:'La contraseña debe tener al menos 12 caracteres.'});const passwordHash=await hashPassword(input.password),rows=await storage.update('usuarios',items=>{const index=items.findIndex(x=>x.id===passwordMatch[1]);if(index<0)throw fail(404,'Cuenta no encontrada.');items[index]={...items[index],passwordHash,actualizadoEn:new Date().toISOString()};return items;});await audit(user,'restablecer_contraseña',passwordMatch[1]);const{passwordHash:_hash,...safe}=rows.find(x=>x.id===passwordMatch[1]);return json(res,200,safe);
      }
      const stateMatch=url.pathname.match(/^\/api\/([^/]+)\/([^/]+)\/estado$/);
      if(req.method==='PATCH'&&stateMatch&&user.rol==='direccion'){
        const [,collection,id]=stateMatch;if(!['usuarios',...createCollections].includes(collection))return json(res,403,{error:'Esta categoría no admite cambios de estado desde esta ruta.'});
        const updated=await storage.update(collection,rows=>{const index=rows.findIndex(x=>x.id===id);if(index<0)throw fail(404,'Registro no encontrado.');const item={...rows[index]};if(collection==='periodos_evaluacion')item.estado=item.estado==='cerrado'?'abierto':'cerrado';else{const field=collection==='usuarios'?'activo':collection==='relaciones_tutores'?'activa':collection==='avisos_escolares'?'publicado':'activo';item[field]=!(item[field]??true);if(collection==='relaciones_tutores')item.estado=item.activa?'activa':'inactiva';}item.actualizadoEn=new Date().toISOString();rows[index]=item;return rows;});
        await audit(user,'cambiar_estado',`${collection}:${id}`);const item=updated.find(x=>x.id===id);if(item.passwordHash){const{passwordHash,...safe}=item;return json(res,200,safe)}if(collection==='avisos_escolares'&&item.publicado)return json(res,200,{...item,notificacionesPush:await notifyPublishedAnnouncement(item)});return json(res,200,item);
      }
      const match = url.pathname.match(/^\/api\/([^/]+)$/);
      if (match && req.method === 'GET') {
        const collection = match[1];
        if (!COLLECTIONS.includes(collection)) return json(res, 404, { error: 'Colección no encontrada.' });
        if(['credenciales_passkey','suscripciones_push'].includes(collection))return json(res,404,{error:'Colección no encontrada.'});
        if(collection==='operaciones')return json(res,403,{error:'Este archivo interno no es consultable por la API.'});
        const allowed = user.rol === 'direccion' || ['avisos_escolares','horarios','asistencias','faltas','retardos','listas_asistencia','calificaciones','boletas','mensajes','justificaciones','permisos'].includes(collection);
        if (!allowed) return json(res, 403, { error: 'Sin permiso para consultar esta información.' });
        const selectedStudentId=url.searchParams.get('alumnoId');let results=await authorizedRecords(collection,user,selectedStudentId);if(collection==='usuarios')results=results.map(({passwordHash,...safe})=>safe);
        for(const key of ['grupoId','materiaId','especialidadId','semestreId','periodoId','estado','fecha']){const value=url.searchParams.get(key);if(value)results=results.filter(row=>String(row[key]??'')===value);}
        const query=url.searchParams.get('q')?.trim().toLocaleLowerCase('es');if(query)results=results.filter(row=>Object.entries(row).filter(([key])=>/nombre|matricula|titulo|materia|asunto/i.test(key)||(collection==='usuarios'&&['email','rol'].includes(key))).some(([,value])=>String(value??'').toLocaleLowerCase('es').includes(query)));
        if(collection==='usuarios'){const roleOrder={alumno:0,maestro:1,tutor:2,direccion:3};results.sort((a,b)=>(roleOrder[a.rol]??9)-(roleOrder[b.rol]??9)||String(a.nombre??'').localeCompare(String(b.nombre??''),'es',{sensitivity:'base'}));}
        const total=results.length,limit=Math.min(200,Math.max(1,Number(url.searchParams.get('limit')??50))),offset=Math.max(0,Number(url.searchParams.get('offset')??0));if(!Number.isFinite(limit)||!Number.isFinite(offset))return json(res,400,{error:'Paginación inválida.'});return json(res, 200, results.slice(offset,offset+limit),{'x-total-count':String(total),'x-limit':String(limit),'x-offset':String(offset)});
      }
      if (req.method==='POST'&&url.pathname==='/api/jornadas'&&user.rol==='direccion'){
        const input=await body(req);if(typeof input.fecha!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(input.fecha))return json(res,400,{error:'Indica una fecha válida (AAAA-MM-DD).'});
        const calendar=await storage.read('calendario_escolar');const calendarDay=calendar.find(x=>x.fecha===input.fecha&&x.activo!==false);if(!calendarDay)return json(res,409,{error:'Primero define esta fecha como lectiva en el calendario escolar.'});if(!['lectivo','clases','jornada_especial'].includes(String(calendarDay.tipo).toLowerCase()))return json(res,409,{error:'El calendario marca esta fecha como día sin clases ordinarias.'});
        const created={id:randomUUID(),fecha:input.fecha,nombre:String(input.nombre??'Jornada ordinaria').trim(),estado:'habilitada',abreEn:input.abreEn??'06:00',cierraEn:input.cierraEn??'08:00',zonaHoraria:input.zonaHoraria??'America/Guatemala',creadoEn:new Date().toISOString(),creadoPor:user.id};
        await storage.update('jornadas',rows=>{if(rows.some(x=>x.fecha===created.fecha&&x.estado==='habilitada'))throw fail(409,'Ya existe una jornada habilitada para esta fecha.');return [...rows,created];});await audit(user,'habilitar_jornada',created.id);return json(res,201,created);
      }
      if(req.method==='DELETE'&&url.pathname.startsWith('/api/jornadas/')&&user.rol==='direccion'){
        const id=decodeURIComponent(url.pathname.slice('/api/jornadas/'.length)),jornada=(await storage.read('jornadas')).find(x=>x.id===id);if(!jornada)return json(res,404,{error:'Jornada no encontrada.'});
        if((await storage.read('asistencias')).some(x=>x.jornadaId===id))return json(res,409,{error:'No se puede borrar esta jornada porque ya tiene entradas registradas. Ciérrala para conservar el historial.'});
        const revoked=(await storage.read('qr_diarios')).filter(x=>x.jornadaId===id&&x.activa).map(x=>({...x,activa:false,revocadaEn:new Date().toISOString()}));
        if(revoked.length)await storage.update('qr_diarios',rows=>rows.map(row=>revoked.find(x=>x.id===row.id)??row));
        await storage.update('jornadas',rows=>rows.filter(row=>row.id!==id));await audit(user,'borrar_jornada',id);return json(res,200,{mensaje:'Jornada borrada.'});
      }
      if(req.method==='GET'&&url.pathname==='/api/mensajes/destinatarios'&&user.rol==='direccion'){
        const recipients=(await storage.read('usuarios')).filter(x=>x.activo).map(({id,nombre,email,rol})=>({id,nombre,email,rol}));return json(res,200,recipients);
      }
      if(req.method==='GET'&&url.pathname==='/api/push/public-key'){
        return json(res,200,{enabled:Boolean(env.VAPID_PUBLIC_KEY&&env.VAPID_PRIVATE_KEY&&env.VAPID_SUBJECT),publicKey:env.VAPID_PUBLIC_KEY??''});
      }
      if(req.method==='POST'&&url.pathname==='/api/push/test'){
        const report=await sendPushNotifications(storage,[user.id],{id:randomUUID(),asunto:'Si recibiste este aviso, las notificaciones están funcionando.',tipo:'prueba'},env);
        return json(res,200,report);
      }
      if(req.method==='POST'&&url.pathname==='/api/push/subscriptions'){
        const input=await body(req),subscription=input.subscription;
        if(!subscription||typeof subscription.endpoint!=='string'||subscription.endpoint.length>3000||!subscription.endpoint.startsWith('https://')||typeof subscription.keys?.p256dh!=='string'||typeof subscription.keys?.auth!=='string')return json(res,400,{error:'La suscripción del dispositivo no es válida.'});
        const saved={id:randomUUID(),usuarioId:user.id,subscription,actualizadaEn:new Date().toISOString()};
        await storage.update('suscripciones_push',rows=>[...rows.filter(row=>!(row.usuarioId===user.id&&row.subscription?.endpoint===subscription.endpoint)),saved]);
        return json(res,201,{mensaje:'Notificaciones activadas en este dispositivo.'});
      }
      if(req.method==='POST'&&url.pathname==='/api/mensajes'&&user.rol==='direccion'){
        const input=await body(req),asunto=typeof input.asunto==='string'?input.asunto.trim():'',contenido=typeof input.contenido==='string'?input.contenido.trim():'',destinatario=typeof input.destinatario==='string'?input.destinatario.trim():'';
        if(asunto.length<2||asunto.length>160||contenido.length<2||contenido.length>5000)return json(res,400,{error:'Escribe un asunto y un mensaje de 2 a 5000 caracteres.'});
        const accounts=(await storage.read('usuarios')).filter(x=>x.activo);let recipients;const groups={todos_usuarios:accounts,todos_alumnos:accounts.filter(x=>x.rol==='alumno'),todos_tutores:accounts.filter(x=>x.rol==='tutor'),todos_maestros:accounts.filter(x=>x.rol==='maestro')};if(Object.hasOwn(groups,destinatario))recipients=groups[destinatario];else recipients=accounts.filter(x=>x.id===destinatario);
        if(!recipients.length)return json(res,404,{error:groups[destinatario]?'No hay cuentas activas de ese grupo para recibir el mensaje.':'Selecciona un usuario activo.'});
        const createdAt=new Date().toISOString(),broadcast=Object.hasOwn(groups,destinatario),messages=recipients.map(target=>({id:randomUUID(),destinatarioUsuarioId:target.id,destinatarioNombre:target.nombre,...(target.rol==='alumno'&&target.personaId?{alumnoId:target.personaId}:{}),alcance:broadcast?destinatario.slice(6):'individual',asunto,contenido,creadoPor:user.id,creadoEn:createdAt,leidoEn:null}));
        await storage.update('mensajes',rows=>[...rows,...messages]);
        const notificacionesPush=await sendPushNotifications(storage,recipients.map(target=>target.id),{id:messages[0].id,asunto},env);
        await audit(user,'enviar_mensaje',broadcast?destinatario+':'+messages.length:recipients[0].id);
        return json(res,201,{mensaje:broadcast?'Mensaje enviado a '+messages.length+' usuario(s) del grupo seleccionado.':'Mensaje enviado.',cantidad:messages.length,notificacionesPush});
      }
      if(req.method==='POST'&&url.pathname==='/api/qr_diarios/renovar'&&user.rol==='direccion'){
        const input=await body(req);const jornada=(await storage.read('jornadas')).find(x=>x.id===input.jornadaId&&x.estado==='habilitada');if(!jornada)return json(res,404,{error:'No existe una jornada habilitada para ese QR.'});
        const versionId=randomUUID();let token,qr;
        await storage.transact(async read=>{
          const all=await read('qr_diarios'),now=Date.now(),occupied=new Set(all.filter(x=>x.activa&&Date.parse(x.expiraEn)>now&&x.jornadaId!==jornada.id).map(x=>x.tokenHash));
          for(let attempt=0;attempt<100;attempt++){const candidate=String(randomInt(0,100000)).padStart(5,'0');if(!occupied.has(hashQrToken(candidate))){token=candidate;break;}}
          if(!token)throw fail(503,'No se pudo generar un código libre. Inténtalo de nuevo.');
          const createdAt=new Date(now).toISOString(),expiresAt=now+10*60*1000;
          qr={id:randomUUID(),jornadaId:jornada.id,versionId,tokenHash:hashQrToken(token),activa:true,creadaEn:createdAt,expiraEn:new Date(expiresAt).toISOString(),creadaPor:user.id};
          const oldVersions=all.filter(x=>x.jornadaId===jornada.id&&x.activa).map(x=>({...x,activa:false,revocadaEn:createdAt}));
          return[{collection:'qr_diarios',upsert:[...oldVersions,qr]}];
        });
        await audit(user,'renovar_qr',jornada.id);return json(res,201,{jornadaId:jornada.id,versionId,token,expiraEn:qr.expiraEn});
      }
      if(req.method==='POST'&&url.pathname==='/api/asistencias/registrar'&&user.rol==='alumno'){
        const attemptKey=user.id,now=Date.now(),attempt=attendanceFailures.get(attemptKey);
        if(attempt&&attempt.until>now&&attempt.count>=10)return json(res,429,{error:'Se alcanzó el límite de intentos de código. Espera 15 minutos y vuelve a intentarlo.'});
        if(attempt&&attempt.until<=now)attendanceFailures.delete(attemptKey);
        const input=await body(req);if(typeof input.token!=='string'||!(/^[0-9]{5}$/.test(input.token)||/^[A-Za-z0-9_-]{22}$/.test(input.token)))return json(res,400,{error:'Escribe el código de 5 números o escanea el QR completo.'});
        const digest=hashQrToken(input.token),version=(await storage.read('qr_diarios')).find(x=>x.activa&&Date.parse(x.expiraEn)>Date.now()&&safeEqual(x.tokenHash,digest));
        if(!version){const state=attendanceFailures.get(attemptKey);attendanceFailures.set(attemptKey,{count:state&&state.until>now?state.count+1:1,until:state&&state.until>now?state.until:now+15*60_000});return json(res,410,{error:'El código venció o no es correcto. Revisa que tenga cinco cifras y genera uno nuevo si expiró.'});}
        attendanceFailures.delete(attemptKey);
        const jornada=(await storage.read('jornadas')).find(x=>x.id===version.jornadaId&&x.estado==='habilitada');if(!jornada)return json(res,409,{error:'La jornada no está habilitada.'});
        if(jornada.fecha!==todayAt(jornada.zonaHoraria))return json(res,410,{error:'El código QR venció o corresponde a otra fecha.'});
        const localTime=timeAt(new Date(),jornada.zonaHoraria);if(localTime<jornada.abreEn||localTime>jornada.cierraEn)return json(res,409,{error:`El código QR sí es válido, pero el registro está cerrado. La jornada permite entradas de ${jornada.abreEn} a ${jornada.cierraEn} (${jornada.zonaHoraria}); ahora son las ${localTime}. Dirección debe habilitar una jornada con el horario correcto.`});
        const student=(await storage.read('alumnos')).find(x=>x.id===user.personaId&&x.activo!==false);if(!student)return json(res,403,{error:'La cuenta no está vinculada con un alumno activo.'});
        const attendance={id:randomUUID(),alumnoId:student.id,nombreSnapshot:[student.nombres,student.apellidos].filter(Boolean).join(' '),fecha:jornada.fecha,jornadaId:jornada.id,horaServidor:new Date().toISOString(),metodo:'qr',estado:'validada',versionQrId:version.versionId};
        await storage.update('asistencias',rows=>{if(rows.some(x=>x.alumnoId===student.id&&x.jornadaId===jornada.id))throw fail(409,'Ya registraste tu entrada para esta jornada.');return [...rows,attendance];});await notifyTutorsOfStudentEvent(student.id,{id:attendance.id,tipo:'llegada',at:attendance.horaServidor});await audit(user,'registrar_entrada',attendance.id);return json(res,201,{mensaje:'Entrada registrada correctamente.',asistencia:attendance});
      }
      if(req.method==='POST'&&url.pathname==='/api/listas_asistencia'&&user.rol==='maestro'){
        const input=await body(req),schedule=(await storage.read('horarios')).find(x=>x.id===input.horarioId&&x.activo!==false&&x.maestroId===user.personaId);if(!schedule)return json(res,403,{error:'La clase no pertenece a tu horario.'});
        const date=input.fecha??todayAt();if(date!==todayAt())return json(res,400,{error:'Solo se puede abrir una lista para la fecha escolar actual.'});const weekday=new Date(`${date}T12:00:00Z`).getUTCDay();if(Number(schedule.diaSemana)!==weekday)return json(res,409,{error:'Esta clase no aparece en el horario para hoy.'});
        const calendarDay=(await storage.read('calendario_escolar')).find(x=>x.fecha===date&&x.activo!==false);if(!calendarDay||!['lectivo','clases','jornada_especial'].includes(String(calendarDay.tipo).toLowerCase()))return json(res,409,{error:'El calendario no marca hoy como día lectivo.'});
        const existing=await storage.read('listas_asistencia');if(existing.some(x=>x.horarioId===schedule.id&&x.fecha===date))return json(res,409,{error:'Ya existe una lista para esta clase y fecha.'});
        const enrollment=await storage.read('inscripciones'),students=await storage.read('alumnos'),members=enrollment.filter(x=>x.grupoId===schedule.grupoId&&x.estado==='activa').map(x=>students.find(s=>s.id===x.alumnoId)).filter(Boolean);
        const list={id:randomUUID(),horarioId:schedule.id,sesionId:schedule.sesionId??schedule.id,fecha:date,maestroId:user.personaId,grupoId:schedule.grupoId,materiaId:schedule.materiaId,estado:'abierta',alumnos:members.map(s=>({alumnoId:s.id,nombreSnapshot:[s.nombres,s.apellidos].filter(Boolean).join(' '),estado:'pendiente'})),creadaEn:new Date().toISOString()};
        await storage.update('listas_asistencia',rows=>{if(rows.some(x=>x.horarioId===schedule.id&&x.fecha===date))throw fail(409,'Ya existe una lista para esta clase y fecha.');return[...rows,list]});await audit(user,'abrir_lista',list.id);return json(res,201,list);
      }
      const closeMatch=url.pathname.match(/^\/api\/listas_asistencia\/([^/]+)\/cerrar$/);
      if(req.method==='POST'&&closeMatch){
        const list=(await storage.read('listas_asistencia')).find(x=>x.id===closeMatch[1]);if(!list||list.estado!=='abierta')return json(res,404,{error:'No existe una lista abierta.'});if(user.rol!=='direccion'&&!(user.rol==='maestro'&&user.personaId===list.maestroId))return json(res,403,{error:'No tienes permiso para cerrar esta lista.'});
        const schedule=(await storage.read('horarios')).find(x=>x.id===list.horarioId);if(schedule&&list.fecha===todayAt()&&schedule.horaFin&&timeAt(new Date(),schedule.zonaHoraria??'America/Guatemala')<schedule.horaFin)return json(res,409,{error:'La clase todavía no termina; la lista no puede cerrarse.'});
        const input=await body(req),states=new Map((input.alumnos??[]).map(x=>[x.alumnoId,x.estado]));const allowedStates=new Set(['presente','retardo','ausente']);if(list.alumnos.some(x=>!allowedStates.has(states.get(x.alumnoId))))return json(res,400,{error:'Confirma el estado de cada alumno antes de cerrar la lista.'});
        const closed={...list,estado:'cerrada',alumnos:list.alumnos.map(x=>({...x,estado:states.get(x.alumnoId)})),cerradaEn:new Date().toISOString(),cerradaPor:user.id};const snapshots=[];
        const approvedPermits=await storage.read('permisos');for(const student of closed.alumnos){if(student.estado==='ausente'){const permit=approvedPermits.find(x=>x.alumnoId===student.alumnoId&&x.fecha===list.fecha&&x.estado==='autorizado');snapshots.push({collection:'faltas',record:{id:`falta_${list.id}_${student.alumnoId}`,alumnoId:student.alumnoId,nombreSnapshot:student.nombreSnapshot,fecha:list.fecha,grupoId:list.grupoId,materiaId:list.materiaId,sesionId:list.sesionId,maestroId:list.maestroId,estado:permit?'justificada':'confirmada',...(permit?{permisoId:permit.id}:{}),listaId:list.id,creadoEn:new Date().toISOString()}});}if(student.estado==='retardo')snapshots.push({collection:'retardos',record:{id:`retardo_${list.id}_${student.alumnoId}`,alumnoId:student.alumnoId,nombreSnapshot:student.nombreSnapshot,fecha:list.fecha,grupoId:list.grupoId,materiaId:list.materiaId,sesionId:list.sesionId,maestroId:list.maestroId,estado:'registrado',listaId:list.id,creadoEn:new Date().toISOString()}});}
        await storage.backup(backupDir);const patches=[{collection:'listas_asistencia',upsert:[closed]},...['faltas','retardos'].map(collection=>({collection,upsert:snapshots.filter(x=>x.collection===collection).map(x=>x.record)}))];await storage.transact(async read=>{const latest=(await read('listas_asistencia')).find(x=>x.id===list.id);if(!latest||latest.estado!=='abierta')throw fail(409,'La lista ya se cerró en otra solicitud.');return patches});for(const student of closed.alumnos.filter(item=>item.estado==='ausente'))await notifyTutorsOfStudentEvent(student.alumnoId,{id:`falta_${list.id}_${student.alumnoId}`,tipo:'falta',at:new Date().toISOString(),materiaNombre:list.materiaNombre??list.materiaSnapshot??list.materiaId});await audit(user,'cerrar_lista',list.id);return json(res,200,closed);
      }
      if(req.method==='POST'&&url.pathname==='/api/calificaciones'&&user.rol==='maestro'){
        const input=await body(req),student=(await storage.read('alumnos')).find(x=>x.id===input.alumnoId),period=(await storage.read('periodos_evaluacion')).find(x=>x.id===input.periodoId&&x.estado!=='cerrado');if(!student||!period)return json(res,400,{error:'Alumno o periodo de evaluación inválido.'});
        const groupId=input.grupoId??(await storage.read('inscripciones')).find(x=>x.alumnoId===student.id&&x.estado==='activa')?.grupoId;
        if(!(await storage.read('horarios')).some(x=>x.activo!==false&&x.maestroId===user.personaId&&x.grupoId===groupId&&x.materiaId===input.materiaId))return json(res,403,{error:'No tienes asignada esta materia y grupo.'});
        const settings=(await storage.read('configuracion'))[0]??{},value=Number(input.valor),min=Number(period.escalaMin??settings.escalaMin??0),max=Number(period.escalaMax??settings.escalaMax??100);if(!Number.isFinite(value)||value<min||value>max)return json(res,400,{error:`La calificación debe estar entre ${min} y ${max}.`});
        if((await storage.read('boletas')).some(x=>x.alumnoId===student.id&&x.periodoId===period.id&&x.publicada))return json(res,409,{error:'La boleta ya fue publicada. Dirección debe retirarla antes de una corrección.'});
        const now=new Date().toISOString();let savedGrade;
        await storage.transact(async read=>{const rows=await read('calificaciones'),boletas=await read('boletas');if(boletas.some(x=>x.alumnoId===student.id&&x.periodoId===period.id&&x.publicada))throw fail(409,'La boleta ya fue publicada. Dirección debe retirarla antes de una corrección.');const old=rows.find(x=>x.alumnoId===student.id&&x.materiaId===String(input.materiaId)&&x.periodoId===period.id);savedGrade={id:old?.id??randomUUID(),alumnoId:student.id,materiaId:String(input.materiaId),maestroId:user.personaId,grupoId:groupId,periodoId:period.id,valor:value,estado:'borrador',modificadoPor:user.id,modificadoEn:now,creadoEn:old?.creadoEn??now};return[{collection:'calificaciones',upsert:[savedGrade]}];});await audit(user,'capturar_calificacion',savedGrade.id);return json(res,201,savedGrade);
      }
      if(req.method==='POST'&&url.pathname==='/api/boletas/publicar'&&user.rol==='direccion'){
        const input=await body(req),studentId=input.alumnoId,periodId=input.periodoId;if(!(await storage.read('alumnos')).some(x=>x.id===studentId)||!(await storage.read('periodos_evaluacion')).some(x=>x.id===periodId))return json(res,400,{error:'Alumno o periodo inválido.'});
        await storage.backup(backupDir);const published=await storage.transact(async read=>{const grades=(await read('calificaciones')).filter(x=>x.alumnoId===studentId&&x.periodoId===periodId);if(!grades.length)throw fail(409,'No hay calificaciones para publicar.');const all=await read('boletas'),old=all.find(x=>x.alumnoId===studentId&&x.periodoId===periodId);const boleta={id:old?.id??randomUUID(),alumnoId:studentId,periodoId:periodId,publicada:true,publicadaEn:new Date().toISOString(),publicadaPor:user.id,referenciasCalificacionIds:grades.map(x=>x.id)};return[{collection:'boletas',upsert:[boleta]}];});await audit(user,'publicar_boleta',studentId);const boleta=(await storage.read('boletas')).find(x=>x.alumnoId===studentId&&x.periodoId===periodId);return json(res,200,boleta);
      }
      if(req.method==='POST'&&url.pathname==='/api/permisos'&&['alumno','tutor'].includes(user.rol)){
        const input=await body(req),alumnoId=user.rol==='alumno'?user.personaId:String(input.alumnoId??''),student=(await storage.read('alumnos')).find(x=>x.id===alumnoId&&x.activo!==false);
        if(!student)return json(res,404,{error:'No se encontró una ficha activa para el alumno.'});
        if(user.rol==='tutor'&&!(await storage.read('relaciones_tutores')).some(x=>x.tutorId===user.personaId&&x.alumnoId===alumnoId&&x.activa))return json(res,403,{error:'El alumno no está vinculado a tu cuenta.'});
        const validDate=typeof input.fecha==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(input.fecha)&&!Number.isNaN(Date.parse(`${input.fecha}T00:00:00Z`))&&new Date(`${input.fecha}T00:00:00Z`).toISOString().slice(0,10)===input.fecha;if(!validDate||typeof input.motivo!=='string'||input.motivo.trim().length<10||input.motivo.trim().length>2000)return json(res,400,{error:'Indica una fecha válida y describe el motivo con al menos 10 caracteres.'});
        const validImage=value=>typeof value==='string'&&/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)&&Buffer.from(value.slice(value.indexOf(',')+1),'base64').length<=1_800_000;
        if(!validImage(input.fotoCredencial)||Buffer.from(input.fotoCredencial.slice(input.fotoCredencial.indexOf(',')+1),'base64').length>1_000_000)return json(res,400,{error:'Adjunta una foto JPG, PNG o WEBP legible de la credencial (máximo 1 MB después de comprimir).'});
        if(input.firmaTutor&&!(typeof input.firmaTutor==='string'&&/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(input.firmaTutor)&&Buffer.from(input.firmaTutor.slice(input.firmaTutor.indexOf(',')+1),'base64').length<=300_000))return json(res,400,{error:'La firma opcional no tiene un formato válido.'});
        const existing=(await storage.read('permisos')).find(x=>x.alumnoId===alumnoId&&x.fecha===input.fecha&&['pendiente','autorizado'].includes(x.estado));if(existing)return json(res,409,{error:'Ya existe un permiso pendiente o autorizado para ese alumno y fecha.'});
        const permit={id:randomUUID(),alumnoId,tutorId:user.rol==='tutor'?user.personaId:null,nombreSnapshot:[student.nombres,student.apellidos].filter(Boolean).join(' '),matricula:student.matricula,fecha:input.fecha,motivo:input.motivo.trim(),fotoCredencial:input.fotoCredencial,...(input.firmaTutor?{firmaTutor:input.firmaTutor}:{}),estado:'pendiente',solicitadoPor:user.id,solicitadoEn:new Date().toISOString()};
        await storage.update('permisos',rows=>[...rows,permit]);await audit(user,'solicitar_permiso',permit.id);return json(res,201,{id:permit.id,estado:permit.estado,fecha:permit.fecha,mensaje:'Solicitud enviada. El permiso solo tendrá efecto después de la revisión y autorización de Dirección.'});
      }
      const permissionMatch=url.pathname.match(/^\/api\/permisos\/([^/]+)\/resolver$/);
      if(req.method==='POST'&&permissionMatch&&user.rol==='direccion'){
        const input=await body(req),decision=input.decision;if(!['autorizar','rechazar'].includes(decision))return json(res,400,{error:'La decisión debe ser autorizar o rechazar.'});if(decision==='autorizar'&&input.revisionCompleta!==true)return json(res,400,{error:'Confirma que revisaste la credencial, el motivo, la fecha y los datos del alumno.'});let resolved;
        await storage.transact(async read=>{const permits=await read('permisos'),current=permits.find(x=>x.id===permissionMatch[1]);if(!current||current.estado!=='pendiente')throw fail(409,'El permiso no existe o ya fue revisado.');if(decision==='autorizar'&&(!current.fotoCredencial||!current.motivo||!current.alumnoId||!current.fecha))throw fail(409,'El permiso está incompleto y no se puede autorizar.');resolved={...current,estado:decision==='autorizar'?'autorizado':'rechazado',resueltaPor:user.id,resueltaEn:new Date().toISOString()};const patches=[{collection:'permisos',upsert:[resolved]}];if(decision==='autorizar'){const faults=await read('faltas'),matching=faults.filter(x=>x.alumnoId===current.alumnoId&&x.fecha===current.fecha);if(matching.length)patches.push({collection:'faltas',upsert:matching.map(x=>({...x,estado:'justificada',permisoId:current.id,actualizadoEn:new Date().toISOString()}))});}return patches;});await audit(user,`resolver_permiso_${decision}`,resolved.id);const{fotoCredencial,firmaTutor,...safe}=resolved;return json(res,200,safe);
      }
      if(req.method==='POST'&&url.pathname==='/api/justificaciones'&&user.rol==='tutor'){
        const input=await body(req),link=(await storage.read('relaciones_tutores')).find(x=>x.tutorId===user.personaId&&x.alumnoId===input.alumnoId&&x.activa);if(!link)return json(res,403,{error:'El alumno no está vinculado a tu cuenta.'});const faults=await storage.read('faltas'),delays=await storage.read('retardos'),record=faults.find(x=>x.id===input.registroId)||delays.find(x=>x.id===input.registroId);if(!record||record.alumnoId!==input.alumnoId)return json(res,404,{error:'No se encontró una falta o retardo de ese alumno.'});if(typeof input.motivo!=='string'||input.motivo.trim().length<5)return json(res,400,{error:'Describe el motivo de la solicitud.'});
        const request={id:randomUUID(),alumnoId:input.alumnoId,tutorId:user.personaId,registroId:record.id,tipo:faults.some(x=>x.id===record.id)?'falta':'retardo',motivo:input.motivo.trim(),estado:'pendiente',solicitadoEn:new Date().toISOString()};await storage.update('justificaciones',rows=>{if(rows.some(x=>x.registroId===record.id&&x.estado==='pendiente'))throw fail(409,'Ya existe una solicitud pendiente para este registro.');return[...rows,request]});await audit(user,'solicitar_justificacion',request.id);return json(res,201,request);
      }
      const resolveMatch=url.pathname.match(/^\/api\/justificaciones\/([^/]+)\/resolver$/);
      if(req.method==='POST'&&resolveMatch&&user.rol==='direccion'){
        const input=await body(req),decision=input.decision;if(!['autorizar','rechazar'].includes(decision))return json(res,400,{error:'La decisión debe ser autorizar o rechazar.'});let resolved;
        await storage.transact(async read=>{const all=await read('justificaciones'),current=all.find(x=>x.id===resolveMatch[1]);if(!current||current.estado!=='pendiente')throw fail(409,'La solicitud no existe o ya fue resuelta.');resolved={...current,estado:decision==='autorizar'?'autorizada':'rechazada',resueltaPor:user.id,resueltaEn:new Date().toISOString()};const patches=[{collection:'justificaciones',upsert:[resolved]}];if(decision==='autorizar'){const collection=current.tipo==='falta'?'faltas':'retardos',items=await read(collection),item=items.find(x=>x.id===current.registroId);if(item)patches.push({collection,upsert:[{...item,estado:'justificada',justificacionId:current.id,actualizadoEn:new Date().toISOString()}]});}return patches;});await audit(user,`resolver_justificacion_${decision}`,resolved.id);return json(res,200,resolved);
      }
      const withdrawMatch=url.pathname.match(/^\/api\/boletas\/([^/]+)\/retirar$/);
      if(req.method==='POST'&&withdrawMatch&&user.rol==='direccion'){
        const list=await storage.read('boletas'),current=list.find(x=>x.id===withdrawMatch[1]&&x.publicada);if(!current)return json(res,404,{error:'No existe una boleta publicada con ese ID.'});const updated={...current,publicada:false,retiradaEn:new Date().toISOString(),retiradaPor:user.id};await storage.update('boletas',rows=>rows.map(x=>x.id===current.id?updated:x));await audit(user,'retirar_boleta',current.id);return json(res,200,updated);
      }
      const closeDay=url.pathname.match(/^\/api\/jornadas\/([^/]+)\/cerrar$/);
      if(req.method==='POST'&&closeDay&&user.rol==='direccion'){
        const current=(await storage.read('jornadas')).find(x=>x.id===closeDay[1]);if(!current)return json(res,404,{error:'Jornada no encontrada.'});const closed={...current,estado:'cerrada',cerradaEn:new Date().toISOString(),cerradaPor:user.id};
        const revoked=(await storage.read('qr_diarios')).filter(x=>x.jornadaId===current.id&&x.activa).map(x=>({...x,activa:false,revocadaEn:new Date().toISOString()}));await storage.transact([{collection:'jornadas',upsert:[closed]},{collection:'qr_diarios',upsert:revoked}]);await audit(user,'cerrar_jornada',current.id);return json(res,200,closed);
      }
      if (match && req.method === 'POST' && match[1] === 'usuarios' && user.rol === 'direccion') {
        const input = await body(req);
        const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
        if (!email.includes('@') || typeof input.nombre !== 'string' || !input.nombre.trim() || !roles.includes(input.rol) || typeof input.password !== 'string' || input.password.length < 12) return json(res, 400, { error: 'Indica nombre, correo válido, rol y contraseña de al menos 12 caracteres.' });
        let personaId = input.personaId;
        if(input.rol==='alumno'){
          const matricula=typeof input.matricula==='string'?input.matricula.trim().toLocaleLowerCase('es'):'';
          const student=(await storage.read('alumnos')).find(person=>String(person.matricula??'').trim().toLocaleLowerCase('es')===matricula&&person.activo!==false);
          if(!student)return json(res,400,{error:'No existe un alumno activo con esa matrícula.'});
          const area=(await storage.read('especialidades')).find(x=>x.activo!==false&&normalizeAreaName(x.nombre)===normalizeAreaName(input.especialidad));if(!area)return json(res,400,{error:'La especialidad no coincide con un área activa.'});if(student.especialidadId&&student.especialidadId!==area.id)return json(res,409,{error:'La especialidad no coincide con el expediente de esa matrícula.'});
          personaId=student.id;input.especialidadId=area.id;
        }else if (input.rol !== 'direccion') {
          const personCollection = { alumno: 'alumnos', maestro: 'maestros', tutor: 'tutores' }[input.rol];
          if (typeof personaId !== 'string' || !(await storage.read(personCollection)).some(person => person.id === personaId)) return json(res, 400, { error: 'La persona asociada al rol no existe.' });
        }
        await storage.backup(backupDir);const passwordHash = await hashPassword(input.password);
        const created = { id: randomUUID(), email, nombre: input.nombre.trim(), rol: input.rol, activo: true, ...(personaId ? { personaId } : {}), ...(input.rol==='alumno'?{especialidadId:input.especialidadId}:{}), passwordHash, creadoEn: new Date().toISOString() };
        await storage.update('usuarios', rows => {
          if (rows.some(item => item.email.toLowerCase() === email)) throw Object.assign(new Error('Ya existe una cuenta con ese correo.'), { status: 409 });
          if(personaId&&rows.some(item=>item.rol===input.rol&&item.personaId===personaId&&item.activo))throw fail(409,'Ese expediente ya tiene una cuenta activa.');
          return [...rows, created];
        });
        await audit(user, 'crear_usuario', created.id);
        const { passwordHash: _secret, ...safe } = created;
        return json(res, 201, safe);
      }
      if (match && req.method === 'POST' && user.rol === 'direccion' && createCollections.includes(match[1])) {
        const collection = match[1];
        const record = await body(req);
        if (!record || typeof record !== 'object' || Array.isArray(record)) return json(res, 400, { error: 'Registro inválido.' });
        if(collection==='avisos_escolares'){record.audiencia=record.audiencia??'usuarios';if(!['usuarios','alumno','tutor','maestro'].includes(record.audiencia))return json(res,400,{error:'Selecciona un destinatario válido para el aviso.'});}
        validateFields(collection,record);
        if(collection==='grupos'){
          const area=(await storage.read('especialidades')).find(x=>x.id===record.especialidadId&&x.activo!==false);if(!area)return json(res,400,{error:'Selecciona un área activa existente.'});record.semestre=Number(record.semestre);if(!Number.isInteger(record.semestre)||record.semestre<1||record.semestre>6)return json(res,400,{error:'Selecciona un semestre del 1 al 6.'});
          if(record.semestreId&&!(await storage.read('semestres')).some(x=>x.id===record.semestreId))return json(res,400,{error:'El semestre indicado no existe.'});
          if(record.especialidadId&&!(await storage.read('especialidades')).some(x=>x.id===record.especialidadId))return json(res,400,{error:'La especialidad indicada no existe.'});
        }
        if(collection==='relaciones_tutores'){
          if(!(await storage.read('tutores')).some(x=>x.id===record.tutorId)||!(await storage.read('alumnos')).some(x=>x.id===record.alumnoId))return json(res,400,{error:'El tutor y el alumno deben existir.'});
        }
        if(collection==='inscripciones'){
          if(!(await storage.read('alumnos')).some(x=>x.id===record.alumnoId)||!(await storage.read('grupos')).some(x=>x.id===record.grupoId))return json(res,400,{error:'El alumno y grupo deben existir.'});
        }
        if(collection==='horarios'){
          for(const [name,id] of [['maestros',record.maestroId],['grupos',record.grupoId],['materias',record.materiaId]])if(!(await storage.read(name)).some(x=>x.id===id))return json(res,400,{error:`La referencia ${name} no existe.`});
          const conflict=(await storage.read('horarios')).find(x=>x.activo!==false&&Number(x.diaSemana)===Number(record.diaSemana)&&[x.maestroId===record.maestroId,x.grupoId===record.grupoId,Boolean(record.aula&&x.aula===record.aula)].some(Boolean)&&record.horaInicio<x.horaFin&&record.horaFin>x.horaInicio);
          if(conflict)return json(res,409,{error:'El horario se cruza con otra clase del mismo maestro, grupo o aula.'});
          record.diaSemana=Number(record.diaSemana);
        }
        if(['horarios','periodos_evaluacion'].includes(collection))await storage.backup(backupDir);
        const saved = { ...record, ...(collection==='avisos_escolares'?{audiencia:record.audiencia??'usuarios'}:{}), id: randomUUID(), creadoEn: new Date().toISOString(), actualizadoEn:new Date().toISOString() };
        await storage.update(collection, rows => {
          const unique=({alumnos:['matricula'],maestros:['numeroEmpleado'],especialidades:['clave'],materias:['clave']}[collection]??[]);
          if(collection==='especialidades'&&rows.some(row=>normalizeAreaName(row.nombre)===normalizeAreaName(saved.nombre)))throw fail(409,'Ya existe un área con ese nombre, aunque cambien los acentos o las mayúsculas.');
          if(unique.some(field=>saved[field]&&rows.some(row=>String(row[field]).toLowerCase()===String(saved[field]).toLowerCase())))throw fail(409,`Ya existe un registro con el mismo ${unique[0]}.`);
          if(collection==='relaciones_tutores'&&rows.some(x=>x.tutorId===saved.tutorId&&x.alumnoId===saved.alumnoId))throw fail(409,'El tutor ya está vinculado a ese alumno.');
          if(collection==='inscripciones'&&saved.estado==='activa'&&rows.some(x=>x.alumnoId===saved.alumnoId&&x.estado==='activa'))throw fail(409,'El alumno ya tiene una inscripción activa.');
          return [...rows, saved];
        });
        await audit(user, 'crear', collection);
        if(collection==='avisos_escolares'&&saved.publicado)return json(res,201,{...saved,notificacionesPush:await notifyPublishedAnnouncement(saved)});
        return json(res, 201, saved);
      }
      return json(res, 404, { error: 'Ruta no encontrada.' });
    }
    const candidate = path.resolve(root, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
    if (!candidate.startsWith(root + path.sep) && candidate !== path.join(root, 'index.html')) return json(res, 403, { error: 'Ruta no permitida.' });
    const info = await stat(candidate).catch(() => null);
    if (!info?.isFile()) return json(res, 404, { error: 'No encontrado.' });
    const ext = path.extname(candidate).toLowerCase();
    const contentTypes={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.webmanifest':'application/manifest+json; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
    res.writeHead(200, { ...securityHeaders,'content-type': contentTypes[ext] ?? 'application/octet-stream','cache-control': candidate.endsWith(`${path.sep}sw.js`) ? 'no-cache' : 'public, max-age=300' });
    res.end(await readFile(candidate));
  } catch (error) { if(!error.status)console.error('Error de solicitud:',error.stack??error.message);json(res, error.status ?? 500, { error: error.status ? error.message : 'Error interno del servidor.' }); }
});
server.listen(port, env.HOST ?? '127.0.0.1', () => console.log(`Plataforma escolar disponible en http://${env.HOST ?? '127.0.0.1'}:${port}`));
setInterval(runScheduledJobs,30_000);
runScheduledJobs();
