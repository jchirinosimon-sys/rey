(function () {
    /* ---------- BASE DE DATOS Y PERSISTENCIA ---------- */
    let estudiantes = JSON.parse(localStorage.getItem("estudiantes")) || [];
    let asistencias = JSON.parse(localStorage.getItem("asistencias")) || [];
    let tutores = JSON.parse(localStorage.getItem("tutores")) || [];
    let cuentas = JSON.parse(localStorage.getItem("cuentas")) || [];
    let avisos = JSON.parse(localStorage.getItem("avisos")) || [];
    let calificaciones = JSON.parse(localStorage.getItem("calificaciones")) || [];
    let permisos = JSON.parse(localStorage.getItem("permisos")) || [];
    let faltas = JSON.parse(localStorage.getItem("faltas")) || [];
    let maestros = JSON.parse(localStorage.getItem("maestros")) || [];

    const DIR_CORREO = "director@cbtismx.com", DIR_PASS = "1234";
    const ENT_CORREO = "entrada@cbtis170.edu.mx", ENT_PASS = "1234";

    const $ = id => document.getElementById(id);
    const get = k => JSON.parse(localStorage.getItem(k) || "[]");
    const set = (k, v) => localStorage.setItem(k, JSON.stringify(v));
    const esc = s => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
    const msg = t => "<div class='mensaje'>" + t + "</div>";
    const hoyL = () => new Date().toLocaleDateString("es-MX");
    const iso = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0"); };
    const fechaOrden = fecha => {
        const valor = String(fecha || "");
        if (/^\d{4}-\d{2}-\d{2}$/.test(valor)) return valor;
        const [dia, mes, anio] = valor.split("/");
        return dia && mes && anio ? `${anio}-${mes.padStart(2,"0")}-${dia.padStart(2,"0")}` : valor;
    };
    const fechaMostrar = fecha => {
        const valor = fechaOrden(fecha);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) return String(fecha || "—");
        const [anio, mes, dia] = valor.split("-").map(Number);
        return new Date(anio, mes - 1, dia).toLocaleDateString("es-MX");
    };
    const card = h => { const d = document.createElement("div"); d.className = "tarjeta"; d.innerHTML = h; return d; };
    const scripts = {};

    function cargarScript(url) {
        if (!scripts[url]) {
            scripts[url] = new Promise((resolve, reject) => {
                const script = document.createElement("script");
                script.src = url;
                script.async = true;
                script.onload = resolve;
                script.onerror = () => {
                    delete scripts[url];
                    reject(new Error("No se pudo cargar " + url));
                };
                document.head.appendChild(script);
            });
        }
        return scripts[url];
    }

    let maestroActual = null, tutorActual = null, lectorIniciado = false, correoMaestro = "", passwordMaestro = "", scannerGeneration = 0;
    const vistas = {};
    let scanner = null;

    function cuentaOk(rol, co, p) {
        return get("cuentas").some(x => x.rol === rol && x.correo.toLowerCase() === co.trim().toLowerCase() && x.password === p);
    }

    function syncCuenta(rol, co, p) {
        let cu = get("cuentas");
        let x = cu.find(y => y.rol === rol && y.correo.toLowerCase() === String(co).toLowerCase());
        if (x) { x.password = p; } else { cu.push({ rol, correo: co, password: p }); }
        set("cuentas", cu);
    }

    let solicitudInstalacion = null;
    function configurarInstalacion() {
        const boton = $("instalarApp"), estado = $("estadoInstalacion");
        if (!boton || !estado) return;
        if (window.matchMedia("(display-mode: standalone)").matches) boton.hidden = true;
        window.addEventListener("beforeinstallprompt", event => {
            event.preventDefault();
            solicitudInstalacion = event;
        });
        window.addEventListener("appinstalled", () => {
            solicitudInstalacion = null;
            boton.hidden = true;
            estado.textContent = "La aplicación quedó instalada en este dispositivo.";
        });
        boton.addEventListener("click", async () => {
            if (!solicitudInstalacion) {
                estado.textContent = "En Chrome, abre el menú ⋮ y elige «Instalar página como aplicación». Debes abrirla mediante HTTPS o localhost; no funciona desde un archivo local.";
                return;
            }
            await solicitudInstalacion.prompt();
            const resultado = await solicitudInstalacion.userChoice;
            estado.textContent = resultado.outcome === "accepted" ? "Instalación iniciada." : "Puedes instalarla más tarde desde el menú de Chrome.";
            solicitudInstalacion = null;
        });
        const hostLocal = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
        if ("serviceWorker" in navigator && (location.protocol === "https:" || hostLocal)) {
            navigator.serviceWorker.register("./sw.js").catch(error => {
                console.error("No se pudo habilitar el modo instalable.", error);
                estado.textContent = "No se pudo habilitar la instalación sin conexión en este momento.";
            });
        } else if (location.protocol === "file:") {
            estado.textContent = "Para instalar en Chrome, sirve esta carpeta en localhost o publícala en HTTPS; Chrome no instala aplicaciones abiertas como archivo local.";
        }
    }

    function comprimirImagen(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error("No se pudo leer la imagen."));
            reader.onload = () => {
                const imagen = new Image();
                imagen.onerror = () => reject(new Error("El archivo seleccionado no es una imagen válida."));
                imagen.onload = () => {
                    const escala = Math.min(1, 900 / Math.max(imagen.width, imagen.height));
                    const canvas = document.createElement("canvas");
                    canvas.width = Math.round(imagen.width * escala);
                    canvas.height = Math.round(imagen.height * escala);
                    const contexto = canvas.getContext("2d");
                    if (!contexto) { reject(new Error("No se pudo procesar la imagen.")); return; }
                    contexto.drawImage(imagen, 0, 0, canvas.width, canvas.height);
                    resolve(canvas.toDataURL("image/jpeg", 0.68));
                };
                imagen.src = String(reader.result);
            };
            reader.readAsDataURL(file);
        });
    }

    /* ---------- LECTOR QR CONTINUO ---------- */
    async function lectorContinuo() {
        const generation = ++scannerGeneration;
        try {
            await cargarScript("https://unpkg.com/html5-qrcode@2.3.8");
        } catch (error) {
            if (generation !== scannerGeneration) return;
            console.error("No se pudo cargar el lector QR.", error);
            $("resultadoQR").innerHTML = msg("No se pudo cargar el lector QR. Revisa tu conexión e inténtalo de nuevo.");
            lectorIniciado = false;
            return;
        }
        if (generation !== scannerGeneration) return;
        if (typeof Html5Qrcode === "undefined") {
            $("resultadoQR").innerHTML = msg("El lector QR no está disponible en este navegador.");
            lectorIniciado = false;
            return;
        }
        scanner = new Html5Qrcode("lector");
        let espera = false;
        scanner.start({ facingMode: "environment" }, { fps: 10, qrbox: 250 }, codigo => {
            if (espera) return;
            espera = true; setTimeout(() => espera = false, 3000);
            if (asistencias.some(a => a.matricula === codigo && a.fecha === hoyL())) {
                $("resultadoQR").innerHTML = msg("ℹ️ Este alumno ya registró su entrada hoy."); return;
            }
            registrarEntrada(codigo);
        }, () => {}).catch(error => {
            console.error("No se pudo iniciar la cámara.", error);
            $("resultadoQR").innerHTML = msg("❌ No se pudo iniciar la cámara.");
            scanner = null;
            lectorIniciado = false;
        });
    }

    function detenerLector() {
        scannerGeneration++;
        if (scanner) {
            const lectorActual = scanner;
            scanner = null;
            lectorActual.stop().then(() => lectorActual.clear()).catch(error => {
                console.error("No se pudo detener el lector QR.", error);
                if ($("resultadoQR")) $("resultadoQR").innerHTML = msg("No se pudo cerrar el lector de cámara correctamente.");
            });
        }
        lectorIniciado = false;
    }

    /* ---------- ESTADÍSTICAS Y TABLAS ESCUELA ---------- */
    window.actualizarEstadisticas = function() {
        if ($("totalAsistencias")) $("totalAsistencias").textContent = asistencias.length;
        if ($("asistenciaHoy")) $("asistenciaHoy").textContent = asistencias.filter(a => a.fecha === hoyL()).length;
        if ($("totalEstudiantes")) $("totalEstudiantes").textContent = estudiantes.length;
        if ($("totalFaltas")) $("totalFaltas").textContent = faltas.length;
        if ($("solicitudesPendientes")) $("solicitudesPendientes").textContent = permisos.filter(p => !p.estado || p.estado === "Pendiente").length;
    };

    window.actualizarTabla = function() {
        const tabla = $("tablaAsistencias");
        if (!tabla) return;
        tabla.innerHTML = "";
        asistencias.forEach(a => {
            tabla.innerHTML += `<tr><td>${esc(a.nombre)}</td><td>${esc(a.grupo)}</td><td>${esc(a.fecha)}</td><td>${esc(a.hora)}</td></tr>`;
        });
    };

    function registrarEntrada(matricula) {
        const estudiante = estudiantes.find(e => e.matricula === matricula);
        if (!estudiante) {
            $("resultadoQR").innerHTML = msg("❌ Estudiante no encontrado.");
            return;
        }
        const fecha = hoyL();
        const hora = new Date().toLocaleTimeString("es-MX");
        const asistencia = { nombre: estudiante.nombre, matricula: estudiante.matricula, grupo: estudiante.grupo, fecha, hora };
        
        asistencias.push(asistencia);
        set("asistencias", asistencias);

        $("resultadoQR").innerHTML = `<div class='mensaje'>✅ Entrada registrada<br><br><strong>${esc(estudiante.nombre)}</strong><br>Fecha: ${fecha}<br>Hora: ${hora}</div>`;
        actualizarTabla();
        actualizarEstadisticas();
    }

    /* ---------- GENERAR QR ---------- */
    window.generarQR = async function(estudiante) {
        if ($("credNombre")) $("credNombre").textContent = estudiante.nombre;
        if ($("credMatricula")) $("credMatricula").textContent = estudiante.matricula;
        if ($("credGrupo")) $("credGrupo").textContent = estudiante.grupo;
        if ($("credEsp")) $("credEsp").textContent = estudiante.especialidad || "--------";
        
        const qrContainer = $("qrcode");
        if (qrContainer) {
            qrContainer.innerHTML = "";
            try {
                await cargarScript("https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js");
                new window.QRCode(qrContainer, { text: estudiante.matricula, width: 180, height: 180 });
            } catch (error) {
                console.error("No se pudo generar la credencial QR.", error);
                qrContainer.textContent = "No se pudo cargar el QR. Muestra tu matrícula al personal de entrada.";
            }
        }
    };

    /* ---------- INFORMACIÓN ALUMNO / TUTOR ---------- */
    function info(mat) {
        const av = get("avisos").slice().reverse();
        const cal = get("calificaciones").filter(c => c.matricula === mat);
        let h = "<h3>📢 Avisos</h3>" + (av.length ? av.map(a =>
            `<div class="aviso ${a.tipo==="Día sin clases"?"sin":a.tipo==="Evento"?"ev":""}"><strong>${esc(a.tipo)}</strong>: ${esc(a.titulo)}${a.fecha?"<br>📅 "+esc(fechaMostrar(a.fecha)):""}</div>`
        ).join("") : "<p>Sin avisos.</p>");
        h += "<h3>📝 Calificaciones</h3>" + (cal.length
            ? "<table><tr><th>Materia</th><th>Calificación</th></tr>" + cal.map(c => `<tr><td>${esc(c.materia)}</td><td>${esc(c.nota)}</td></tr>`).join("") + "</table>"
            : "<p>Sin calificaciones.</p>");
        return h;
    }

    /* ---------- RENDER MAESTRO ---------- */
    function mRender() {
        const m = maestroActual; if (!m) return;
        const h = hoyL(), f = iso(), per = get("permisos");
        $("mLista").innerHTML = `<h3>Alumnos registrados — ${h}</h3>` + (estudiantes.length
            ? "<table><tr><th>Alumno</th><th>Grupo</th><th>Estado</th><th></th></tr>" + estudiantes.map(e => {
                const pre = asistencias.some(a => a.matricula === e.matricula && a.fecha === h);
                const p = per.some(x => x.matricula === e.matricula && x.fecha === f && x.estado === "Aprobado");
                const falta = faltas.some(x => x.matricula === e.matricula && x.fecha === f);
                const estado = pre ? "✅ Presente" : p ? "📝 Permiso aprobado" : falta ? "❌ Falta registrada" : "Sin registro";
                return `<tr><td>${esc(e.nombre)}</td><td>${esc(e.grupo || "—")}</td><td>${estado}</td><td>${pre?`<button class="accion" data-q="${esc(e.matricula)}">Quitar entrada</button>`:""}</td></tr>`;
              }).join("") + "</table>"
            : "<p>No hay alumnos registrados.</p>");
        $("mLista").querySelectorAll("[data-q]").forEach(b => b.onclick = () => {
            for (let i = asistencias.length - 1; i >= 0; i--)
                if (asistencias[i].matricula === b.dataset.q && asistencias[i].fecha === h) asistencias.splice(i, 1);
            set("asistencias", asistencias);
            mRender();
            actualizarTabla();
            actualizarEstadisticas();
        });
    }

    /* ---------- UTILIDADES UI ---------- */
    function prep(c, titulo, labels) {
        c.className = "loginBox";
        c.querySelectorAll("h3").forEach(h => h.remove());
        const h2 = c.querySelector("h2"); if (h2) h2.textContent = titulo;
        if (labels) c.querySelectorAll("input").forEach((inp, i) => {
            if (labels[i]) { const l = document.createElement("label"); l.textContent = labels[i]; inp.before(l); inp.placeholder = labels[i]; }
        });
        return c;
    }
    const enlace = (t, fn) => { const b = document.createElement("button"); b.className = "enlace"; b.textContent = t; b.onclick = fn; return b; };

    function signupCard(rol, alCrear) {
        const c = card(`<h2>Crear cuenta</h2><input type="email"><input type="password"><input type="password"><button class="accion">Continuar</button><div></div>`);
        prep(c, "Crear cuenta", ["Correo electrónico", "Contraseña", "Confirmar contraseña"]);
        const [i1, i2, i3] = c.querySelectorAll("input"), m = c.querySelector("div");
        c.querySelector("button.accion").onclick = () => {
            const co = i1.value.trim(), p = i2.value;
            if (!co || !p) { m.innerHTML = msg("Escribe tu correo y contraseña."); return; }
            if (p !== i3.value) { m.innerHTML = msg("❌ Las contraseñas no coinciden."); return; }
            let cu = get("cuentas");
            if (cu.some(x => x.rol === rol && x.correo.toLowerCase() === co.toLowerCase())) { m.innerHTML = msg("Ese correo ya tiene cuenta. Toca “Ya tengo cuenta”."); return; }
            syncCuenta(rol, co, p);
            i1.value = i2.value = i3.value = ""; m.innerHTML = "";
            alCrear(co, p);
        };
        return c;
    }

    function armar(sec, login, signup, perfil, contenido) {
        const C = document.createElement("div"); C.className = "oculto paneles";
        contenido.forEach(n => C.appendChild(n));
        sec.innerHTML = "";
        const paneles = [login, signup, perfil].filter(Boolean);
        sec.append(...paneles, C);
        const show = w => { paneles.forEach(p => p.classList.toggle("oculto", p !== w)); C.classList.toggle("oculto", w !== C); };
        const v = { login: () => show(login), signup: () => show(signup), perfil: () => show(perfil), entrar: () => show(C) };
        if (signup) {
            login.appendChild(enlace("¿No tienes cuenta? Regístrate", () => v.signup()));
            signup.appendChild(enlace("Ya tengo cuenta", () => v.login()));
        }
        if (perfil) perfil.appendChild(enlace("← Volver al inicio de sesión", () => v.login()));
        v.login();
        return v;
    }

    /* ---------- INICIALIZACIÓN GENERAL ---------- */
    function iniciar() {
        const cont = document.querySelector(".contenedor");
        if (!cont || !$("escuela") || !$("estudiante") || !$("tutor")) return;

        const E = { reg: $("nombreEstudiante").closest(".tarjeta"), log: $("loginMatricula").closest(".tarjeta"), cred: $("credNombre").closest(".tarjeta") };
        const T = { reg: $("nombreTutor").closest(".tarjeta"), log: $("loginEmailTutor").closest(".tarjeta"), not: $("notificaciones").closest(".tarjeta"), asis: $("tablaTutor").closest(".tarjeta") };
        const D = { log: $("usuarioEscuela").closest(".tarjeta"), ent: $("lector").closest(".tarjeta"), con: $("tablaAsistencias").closest(".tarjeta") };

        const avisoCard = card(`<h2>📢 Publicar aviso</h2>
            <label for="avTipo">Tipo de aviso</label><select id="avTipo"><option>Día sin clases</option><option>Evento</option><option>Aviso importante</option></select>
            <label for="avTitulo">Descripción</label><input id="avTitulo" placeholder="Descripción del aviso">
            <label for="avFecha">Fecha (opcional)</label><input type="date" id="avFecha">
            <button class="accion" id="avBtn">Publicar</button><div id="avMsg"></div>`);
        
        const calCard = card(`<h2>📝 Subir calificación</h2>
            <label for="calMat">Matrícula del alumno</label><input id="calMat" placeholder="Matrícula">
            <label for="calMateria">Materia</label><input id="calMateria" placeholder="Materia">
            <label for="calNota">Calificación (0 a 10)</label><input id="calNota" type="number" min="0" max="10" step="0.1" placeholder="Calificación">
            <button class="accion" id="calBtn">Subir</button><div id="calMsg"></div>`);
        
        const permCard = card(`<h2>📝 Solicitar permiso o justificar falta</h2>
            <label for="pFecha">Fecha</label><input type="date" id="pFecha">
            <label for="pTipo">Tipo de solicitud</label><select id="pTipo"><option>Permiso anticipado</option><option>Justificación de falta</option><option>Salida anticipada</option></select>
            <label for="pMotivo">Motivo</label><textarea id="pMotivo" rows="3" placeholder="Describe brevemente el motivo"></textarea>
            <label for="pFoto">Foto del comprobante de tutoría</label>
            <input type="file" id="pFoto" accept="image/*">
            <p class="texto-ayuda">Adjunta una foto que permita a Dirección revisar la tutoría. Evita documentos con datos sensibles innecesarios. Máximo 5 MB.</p>
            <div id="pFotoVista"></div>
            <label for="firmaTutor">Firma del tutor</label>
            <canvas id="firmaTutor" width="600" height="180" aria-label="Área para dibujar la firma del tutor"></canvas>
            <div class="controles-firma"><span class="texto-ayuda">Dibuja tu firma con el mouse o el dedo.</span><button class="accion secundario" id="limpiarFirma" type="button">Borrar firma</button></div>
            <button class="accion" id="pBtn">Enviar permiso</button><div id="pMsg"></div>`);
        
        const tInfoCard = card(`<h2>📢 Avisos y calificaciones de mi hijo</h2><div id="tInfo"></div>`);
        const eInfoCard = card(`<h2>📢 Avisos y calificaciones</h2><div id="eInfo"></div>`);
        const tPermCard = card(`<h2>🗂️ Mis solicitudes</h2><div id="tPermisos"></div>`);
        const directorPermCard = card(`<h2>📝 Revisar permisos y justificantes</h2><div id="dPermisos"></div>`);
        const directorFaltaCard = card(`<h2>❌ Registrar falta</h2>
            <label for="fMat">Matrícula del alumno</label><input id="fMat" placeholder="Matrícula">
            <label for="fFecha">Fecha de la falta</label><input type="date" id="fFecha">
            <label for="fMotivo">Observaciones</label><textarea id="fMotivo" rows="3" placeholder="Motivo u observaciones"></textarea>
            <button class="accion" id="fBtn">Registrar falta</button><div id="fMsg"></div><div id="dFaltas"></div>`);
        const directorAlumnosCard = card(`<h2>🎓 Directorio de alumnos</h2>
            <input type="search" id="dBuscar" placeholder="Buscar por nombre, matrícula o grupo" aria-label="Buscar alumnos">
            <div id="dAlumnos"></div>`);

        const maeLogin = card(`<h2>Iniciar Sesión</h2><input type="email" id="mCorreo"><input type="password" id="mPass">
            <button class="accion" id="mEntrar">Iniciar sesión</button><div id="mMsg"></div>`);
        const maePerfil = card(`<h2>Completa tus datos</h2><input id="perNombre">
            <button class="accion" id="perBtn">Guardar y continuar</button><div id="perMsg"></div>`);
        const maeLista = card(`<h2>👩‍🏫 Lista escolar</h2><div id="mLista"></div>`);

        const entLogin = card(`<h2>Iniciar Sesión</h2><input type="email" id="enCorreo"><input type="password" id="enPass">
            <button class="accion" id="enBtn">Iniciar sesión</button><div id="enMsg"></div>`);

        const secMae = document.createElement("section"); secMae.id = "maestro"; secMae.className = "modulo"; cont.appendChild(secMae);
        const secEnt = document.createElement("section"); secEnt.id = "entrada"; secEnt.className = "modulo"; cont.appendChild(secEnt);

        E.reg.querySelector("button.accion").textContent = "Guardar y continuar";
        T.reg.querySelector("button.accion").textContent = "Guardar y continuar";

        /* Campos extra estudiante */
        const inpCorreo = document.createElement("input");
        inpCorreo.type = "email"; inpCorreo.id = "correoEstudiante"; inpCorreo.placeholder = "Correo electrónico";
        $("nombreEstudiante").after(inpCorreo);

        const inpEsp = document.createElement("input");
        inpEsp.type = "text"; inpEsp.id = "especialidadEstudiante"; inpEsp.placeholder = "Especialidad";
        $("grupoEstudiante").after(inpEsp);

        const pEsp = document.createElement("p");
        pEsp.innerHTML = 'Especialidad: <strong id="credEsp">--------</strong>';
        $("credGrupo").parentElement.after(pEsp);

        /* Configurar módulos */
        vistas.estudiante = armar($("estudiante"), prep(E.log, "Iniciar Sesión", ["Correo electrónico o matrícula", "Contraseña"]), signupCard("estudiante", (co, p) => { $("correoEstudiante").value = co; $("passwordEstudiante").value = p; vistas.estudiante.perfil(); }), prep(E.reg, "Completa tus datos", ["Nombre completo", "Correo electrónico", "Matrícula", "Grupo", "Nombre de padre, madre o tutor", "Contraseña"]), [E.cred, eInfoCard]);
        vistas.tutor = armar($("tutor"), prep(T.log, "Iniciar Sesión", ["Correo electrónico", "Contraseña"]), signupCard("tutor", (co, p) => { $("emailTutor").value = co; $("passwordTutor").value = p; vistas.tutor.perfil(); }), prep(T.reg, "Completa tus datos", ["Nombre completo", "Correo electrónico", "Matrícula del alumno", "Contraseña"]), [T.not, T.asis, permCard, tPermCard, tInfoCard]);
        vistas.maestro = armar(secMae, prep(maeLogin, "Iniciar Sesión", ["Correo electrónico", "Contraseña"]), signupCard("maestro", (co, p) => { correoMaestro = co; passwordMaestro = p; vistas.maestro.perfil(); }), prep(maePerfil, "Completa tus datos", ["Nombre completo"]), [maeLista]);
        vistas.escuela = armar($("escuela"), prep(D.log, "Iniciar Sesión", ["Correo electrónico", "Contraseña"]), null, null, [D.con, directorAlumnosCard, directorPermCard, directorFaltaCard, avisoCard, calCard]);
        vistas.entrada = armar(secEnt, prep(entLogin, "Iniciar Sesión", ["Correo electrónico", "Contraseña"]), null, null, [D.ent]);

        $("loginMatricula").type = "email"; $("usuarioEscuela").type = "email";
        const accesoDemo = document.createElement("p");
        accesoDemo.className = "nota-acceso";
        accesoDemo.textContent = "Acceso de prueba: " + DIR_CORREO + " · contraseña: " + DIR_PASS;
        D.log.insertBefore(accesoDemo, D.log.querySelector("#mensajeEscuela"));
        const accesoEntrada = document.createElement("p");
        accesoEntrada.className = "nota-acceso";
        accesoEntrada.textContent = "Acceso de prueba: " + ENT_CORREO + " · contraseña: " + ENT_PASS;
        entLogin.insertBefore(accesoEntrada, entLogin.querySelector("#enMsg"));

        function renderDireccion() {
            const dPermisos = $("dPermisos");
            dPermisos.innerHTML = permisos.length ? `<div class="tabla-contenedor"><table><thead><tr><th>Alumno</th><th>Tutor y evidencia</th><th>Fecha</th><th>Tipo</th><th>Motivo</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>${permisos.map((p, i) => {
                const alumno = estudiantes.find(e => e.matricula === p.matricula);
                const estado = p.estado || "Pendiente";
                const tutor = tutores.find(t => t.email === p.tutorEmail);
                const nombreTutor = p.tutorNombre || (tutor && tutor.nombre) || "Tutor";
                const evidencia = p.foto && p.firma
                    ? `<details class="evidencia"><summary>Ver foto y firma</summary><img src="${esc(p.foto)}" alt="Foto del comprobante de tutoría"><img class="firma-evidencia" src="${esc(p.firma)}" alt="Firma enviada por el tutor"></details>`
                    : "<span>Evidencia no disponible (solicitud anterior)</span>";
                return `<tr><td>${esc(alumno ? alumno.nombre : p.matricula)}</td><td>${esc(nombreTutor)}${p.tutorEmail ? `<br><small>${esc(p.tutorEmail)}</small>` : ""}${evidencia}</td><td>${esc(fechaMostrar(p.fecha))}</td><td>${esc(p.tipo || "Permiso")}</td><td>${esc(p.motivo || "—")}</td><td>${esc(estado)}</td><td>${estado === "Pendiente" ? `<button class="accion" data-perm="${i}" data-estado="Aprobado">Aprobar</button> <button class="accion secundario" data-perm="${i}" data-estado="Rechazado">Rechazar</button>` : "—"}</td></tr>`;
            }).join("")}</tbody></table></div>` : "<p>No hay solicitudes de permiso.</p>";
            dPermisos.querySelectorAll("[data-perm]").forEach(button => button.onclick = () => {
                const solicitud = permisos[Number(button.dataset.perm)];
                if (!solicitud) return;
                solicitud.estado = button.dataset.estado;
                set("permisos", permisos);
                renderDireccion();
                actualizarEstadisticas();
            });

            const filtro = $("dBuscar").value.trim().toLowerCase();
            const alumnos = estudiantes.filter(e => [e.nombre, e.matricula, e.grupo].some(v => String(v || "").toLowerCase().includes(filtro)));
            $("dAlumnos").innerHTML = alumnos.length ? `<div class="tabla-contenedor"><table><thead><tr><th>Alumno</th><th>Matrícula</th><th>Grupo</th><th>Faltas registradas</th><th>Acciones</th></tr></thead><tbody>${alumnos.map(e => `<tr><td>${esc(e.nombre)}</td><td>${esc(e.matricula)}</td><td>${esc(e.grupo || "—")}</td><td>${faltas.filter(f => f.matricula === e.matricula).length}</td><td><button class="accion peligro" type="button" data-eliminar-alumno="${esc(e.matricula)}">Eliminar alumno</button></td></tr>`).join("")}</tbody></table></div>` : filtro ? "<p>No hay alumnos que coincidan con la búsqueda.</p>" : "<p>Aún no hay alumnos registrados.</p>";
            $("dAlumnos").querySelectorAll("[data-eliminar-alumno]").forEach(button => button.onclick = () => {
                const matricula = button.dataset.eliminarAlumno;
                const alumno = estudiantes.find(e => e.matricula === matricula);
                if (!alumno || !window.confirm(`¿Eliminar a ${alumno.nombre} (${alumno.matricula})? También se borrarán sus asistencias, faltas, permisos, calificaciones y cuentas vinculadas.`)) return;
                const tutoresEliminados = tutores.filter(t => t.hijo === matricula);
                estudiantes = estudiantes.filter(e => e.matricula !== matricula);
                asistencias = asistencias.filter(a => a.matricula !== matricula);
                faltas = faltas.filter(f => f.matricula !== matricula);
                permisos = permisos.filter(p => p.matricula !== matricula);
                calificaciones = calificaciones.filter(c => c.matricula !== matricula);
                tutores = tutores.filter(t => t.hijo !== matricula);
                const correosTutor = tutoresEliminados.map(t => t.email.toLowerCase());
                cuentas = cuentas.filter(c => !(
                    (c.rol === "estudiante" && alumno.correo && c.correo.toLowerCase() === alumno.correo.toLowerCase()) ||
                    (c.rol === "tutor" && correosTutor.includes(c.correo.toLowerCase()))
                ));
                set("estudiantes", estudiantes);
                set("asistencias", asistencias);
                set("faltas", faltas);
                set("permisos", permisos);
                set("calificaciones", calificaciones);
                set("tutores", tutores);
                set("cuentas", cuentas);
                actualizarTabla();
                actualizarEstadisticas();
                renderDireccion();
            });

            $("dFaltas").innerHTML = faltas.length ? `<h3>Faltas registradas</h3><div class="tabla-contenedor"><table><thead><tr><th>Alumno</th><th>Fecha</th><th>Observaciones</th></tr></thead><tbody>${faltas.slice().reverse().map(f => {
                const alumno = estudiantes.find(e => e.matricula === f.matricula);
                return `<tr><td>${esc(alumno ? alumno.nombre : f.matricula)}</td><td>${esc(fechaMostrar(f.fecha))}</td><td>${esc(f.motivo || "—")}</td></tr>`;
            }).join("")}</tbody></table></div>` : "<p>Aún no hay faltas registradas.</p>";
        }
        $("dBuscar").addEventListener("input", renderDireccion);
        $("fFecha").value = iso();

        let fotoPermiso = "";
        let firmaTrazada = false;
        const canvasFirma = $("firmaTutor");
        const contextoFirma = canvasFirma.getContext("2d");
        contextoFirma.strokeStyle = "#123c68";
        contextoFirma.lineWidth = 3;
        contextoFirma.lineCap = "round";
        contextoFirma.lineJoin = "round";
        let dibujandoFirma = false;
        canvasFirma.addEventListener("pointerdown", event => {
            dibujandoFirma = true;
            firmaTrazada = true;
            canvasFirma.setPointerCapture(event.pointerId);
            const rect = canvasFirma.getBoundingClientRect();
            contextoFirma.beginPath();
            contextoFirma.moveTo((event.clientX - rect.left) * canvasFirma.width / rect.width, (event.clientY - rect.top) * canvasFirma.height / rect.height);
        });
        canvasFirma.addEventListener("pointermove", event => {
            if (!dibujandoFirma) return;
            const rect = canvasFirma.getBoundingClientRect();
            contextoFirma.lineTo((event.clientX - rect.left) * canvasFirma.width / rect.width, (event.clientY - rect.top) * canvasFirma.height / rect.height);
            contextoFirma.stroke();
        });
        const terminarFirma = () => { dibujandoFirma = false; };
        canvasFirma.addEventListener("pointerup", terminarFirma);
        canvasFirma.addEventListener("pointercancel", terminarFirma);
        $("limpiarFirma").onclick = () => {
            contextoFirma.clearRect(0, 0, canvasFirma.width, canvasFirma.height);
            firmaTrazada = false;
        };
        $("pFoto").addEventListener("change", async () => {
            const archivo = $("pFoto").files[0];
            fotoPermiso = "";
            $("pFotoVista").innerHTML = "";
            if (!archivo) return;
            if (!archivo.type.startsWith("image/")) {
                $("pFoto").value = "";
                $("pFotoVista").innerHTML = msg("Selecciona un archivo de imagen.");
                return;
            }
            if (archivo.size > 5 * 1024 * 1024) {
                $("pFoto").value = "";
                $("pFotoVista").innerHTML = msg("La imagen debe pesar menos de 5 MB.");
                return;
            }
            try {
                fotoPermiso = await comprimirImagen(archivo);
                $("pFotoVista").innerHTML = `<img class="vista-comprobante" src="${fotoPermiso}" alt="Vista previa del comprobante seleccionado">`;
            } catch (error) {
                console.error("No se pudo procesar el comprobante del tutor.", error);
                $("pFoto").value = "";
                $("pFotoVista").innerHTML = msg("No se pudo procesar esa imagen. Prueba con JPG, PNG o WebP.");
            }
        });

        /* Eventos de Director */
        D.log.querySelector("button.accion").onclick = () => {
            const ok = $("usuarioEscuela").value.trim().toLowerCase() === DIR_CORREO.toLowerCase() && $("passwordEscuela").value === DIR_PASS;
            if (!ok) { $("mensajeEscuela").innerHTML = msg("❌ Correo o contraseña incorrectos."); return; }
            $("mensajeEscuela").innerHTML = "";
            vistas.escuela.entrar();
            actualizarTabla();
            actualizarEstadisticas();
            renderDireccion();
        };
        $("avBtn").onclick = () => {
            const titulo = $("avTitulo").value.trim();
            if (!titulo) { $("avMsg").innerHTML = msg("Escribe la descripción."); return; }
            avisos.push({ tipo: $("avTipo").value, titulo, fecha: $("avFecha").value }); set("avisos", avisos);
            $("avTitulo").value = ""; $("avMsg").innerHTML = msg("✅ Aviso publicado.");
        };
        $("calBtn").onclick = () => {
            const mat = $("calMat").value.trim(), materia = $("calMateria").value.trim(), nota = $("calNota").value;
            const al = estudiantes.find(e => e.matricula === mat);
            if (!al) { $("calMsg").innerHTML = msg("❌ Matrícula no encontrada."); return; }
            if (!materia || nota === "") { $("calMsg").innerHTML = msg("Completa materia y calificación."); return; }
            if (!Number.isFinite(Number(nota)) || Number(nota) < 0 || Number(nota) > 10) { $("calMsg").innerHTML = msg("La calificación debe estar entre 0 y 10."); return; }
            calificaciones.push({ matricula: mat, materia, nota, fecha: hoyL() }); set("calificaciones", calificaciones);
            $("calMsg").innerHTML = msg("✅ Calificación subida a " + esc(al.nombre));
            $("calMateria").value = ""; $("calNota").value = "";
        };
        $("fBtn").onclick = () => {
            const matricula = $("fMat").value.trim(), fecha = $("fFecha").value, motivo = $("fMotivo").value.trim();
            const alumno = estudiantes.find(e => e.matricula === matricula);
            if (!alumno) { $("fMsg").innerHTML = msg("❌ Matrícula no encontrada."); return; }
            if (!fecha) { $("fMsg").innerHTML = msg("Selecciona la fecha de la falta."); return; }
            if (asistencias.some(a => a.matricula === matricula && a.fecha === new Date(fecha + "T00:00:00").toLocaleDateString("es-MX"))) {
                $("fMsg").innerHTML = msg("Este alumno ya tiene entrada registrada en esa fecha."); return;
            }
            if (permisos.some(p => p.matricula === matricula && p.fecha === fecha && p.estado === "Aprobado")) {
                $("fMsg").innerHTML = msg("El alumno tiene un permiso aprobado para esa fecha."); return;
            }
            if (faltas.some(f => f.matricula === matricula && f.fecha === fecha)) {
                $("fMsg").innerHTML = msg("La falta ya está registrada."); return;
            }
            faltas.push({ matricula, fecha, motivo }); set("faltas", faltas);
            $("fMsg").innerHTML = msg("✅ Falta registrada para " + esc(alumno.nombre) + ".");
            $("fMat").value = ""; $("fMotivo").value = "";
            renderDireccion();
            actualizarEstadisticas();
        };

        /* Eventos de Entrada QR */
        $("enBtn").onclick = () => {
            if ($("enCorreo").value.trim().toLowerCase() !== ENT_CORREO.toLowerCase() || $("enPass").value !== ENT_PASS) {
                $("enMsg").innerHTML = msg("❌ Correo o contraseña incorrectos."); return;
            }
            $("enMsg").innerHTML = "";
            vistas.entrada.entrar();
        };
        $("iniciarEscaner").onclick = () => {
            if (lectorIniciado) return;
            lectorIniciado = true;
            lectorContinuo();
        };
        $("registrarManual").onclick = () => {
            const matricula = $("matriculaManual").value.trim();
            if (!matricula) {
                $("resultadoQR").innerHTML = msg("Escribe la matrícula para registrar la entrada.");
                return;
            }
            registrarEntrada(matricula);
            $("matriculaManual").value = "";
        };

        /* Eventos de Maestro */
        $("mEntrar").onclick = () => {
            const co = $("mCorreo").value.trim(), p = $("mPass").value;
            const m = maestros.find(x => (x.correo || "").toLowerCase() === co.toLowerCase() && x.pass === p);
            if (m) { maestroActual = m; $("mMsg").innerHTML = ""; vistas.maestro.entrar(); mRender(); return; }
            if (cuentaOk("maestro", co, p)) { correoMaestro = co; passwordMaestro = p; $("mMsg").innerHTML = ""; vistas.maestro.perfil(); return; }
            $("mMsg").innerHTML = msg("❌ Correo o contraseña incorrectos.");
        };
        $("perBtn").onclick = () => {
            const n = $("perNombre").value.trim(), p = passwordMaestro;
            if (!n || !p) { $("perMsg").innerHTML = msg("Completa todos los campos."); return; }
            const m = { correo: correoMaestro, nombre: n, pass: p };
            maestros.push(m); set("maestros", maestros);
            syncCuenta("maestro", correoMaestro, p);
            maestroActual = m; $("perMsg").innerHTML = "";
            vistas.maestro.entrar(); mRender();
        };

        /* Eventos de Tutor */
        function entrarTutor(t) {
            tutorActual = t;
            $("loginTutorMensaje").innerHTML = ""; $("registroTutor").innerHTML = "";
            $("tInfo").innerHTML = info(t.hijo);
            const asistenciasTutor = asistencias.filter(a => a.matricula === t.hijo);
            const faltasTutor = faltas.filter(f => f.matricula === t.hijo);
            const pendientesTutor = permisos.filter(p => p.matricula === t.hijo && (!p.estado || p.estado === "Pendiente"));
            $("resumenTutor").innerHTML = `<div class="estadistica"><strong>${asistenciasTutor.length}</strong><span>Entradas registradas</span></div><div class="estadistica"><strong>${faltasTutor.length}</strong><span>Faltas registradas</span></div><div class="estadistica"><strong>${pendientesTutor.length}</strong><span>Solicitudes pendientes</span></div>`;
            const avisosTutor = avisos.slice().reverse();
            $("notificaciones").innerHTML = avisosTutor.length ? avisosTutor.map(a => `<div class="notificacion"><strong>${esc(a.tipo)}</strong>: ${esc(a.titulo)}${a.fecha ? `<br><span>${esc(fechaMostrar(a.fecha))}</span>` : ""}</div>`).join("") : "<div class='notificacion'>No hay avisos nuevos de la escuela.</div>";
            const alumno = estudiantes.find(e => e.matricula === t.hijo);
            const movimientos = [
                ...asistencias.filter(a => a.matricula === t.hijo).map(a => ({ fecha: a.fecha, hora: a.hora, estado: "✅ Entrada registrada" })),
                ...faltas.filter(f => f.matricula === t.hijo).map(f => ({ fecha: f.fecha, hora: "—", estado: "❌ Falta registrada" })),
                ...permisos.filter(p => p.matricula === t.hijo).map(p => ({ fecha: p.fecha, hora: "—", estado: `${p.estado || "Pendiente"} · ${p.tipo || "Permiso"}` }))
            ];
            movimientos.sort((a, b) => fechaOrden(b.fecha).localeCompare(fechaOrden(a.fecha)));
            $("tablaTutor").innerHTML = movimientos.length ? movimientos.map(a =>
                `<tr><td>${esc(alumno ? alumno.nombre : t.hijo)}</td><td>${esc(fechaMostrar(a.fecha))}</td><td>${esc(a.hora)}</td><td>${esc(a.estado)}</td></tr>`).join("") : "<tr><td colspan='4'>Aún no hay registros de asistencia, faltas o permisos.</td></tr>";
            const solicitudes = permisos.filter(p => p.matricula === t.hijo).slice().reverse();
            $("tPermisos").innerHTML = solicitudes.length ? `<div class="tabla-contenedor"><table><thead><tr><th>Fecha</th><th>Solicitud</th><th>Motivo</th><th>Estado</th></tr></thead><tbody>${solicitudes.map(p => `<tr><td>${esc(fechaMostrar(p.fecha))}</td><td>${esc(p.tipo || "Permiso")}</td><td>${esc(p.motivo || "—")}</td><td>${esc(p.estado || "Pendiente")}</td></tr>`).join("")}</tbody></table></div>` : "<p>Tus solicitudes aparecerán aquí.</p>";
            vistas.tutor.entrar();
        }
        T.log.querySelector("button.accion").onclick = () => {
            const co = $("loginEmailTutor").value.trim(), p = $("loginPasswordTutor").value;
            const t = tutores.find(x => x.email.toLowerCase() === co.toLowerCase() && x.password === p);
            if (t) { entrarTutor(t); return; }
            if (cuentaOk("tutor", co, p)) {
                $("emailTutor").value = co; $("passwordTutor").value = p;
                $("loginTutorMensaje").innerHTML = ""; vistas.tutor.perfil(); return;
            }
            $("loginTutorMensaje").innerHTML = msg("❌ Datos incorrectos.");
        };
        T.reg.querySelector("button.accion").onclick = () => {
            const nombre = $("nombreTutor").value.trim(), email = $("emailTutor").value.trim(), hijo = $("hijoTutor").value.trim(), password = $("passwordTutor").value;
            if (!nombre || !email || !hijo || !password) { $("registroTutor").innerHTML = msg("Completa todos los campos."); return; }
            if (tutores.some(x => x.email.toLowerCase() === email.toLowerCase())) { $("registroTutor").innerHTML = msg("Ese correo ya está registrado."); return; }
            if (!estudiantes.some(e => e.matricula === hijo)) { $("registroTutor").innerHTML = msg("No encontramos esa matrícula. Verifica el dato o contacta a Dirección."); return; }
            const t = { nombre, email, hijo, password };
            tutores.push(t); set("tutores", tutores);
            syncCuenta("tutor", email, password);
            entrarTutor(t);
        };
        $("pBtn").onclick = () => {
            if (!tutorActual) { $("pMsg").innerHTML = msg("Inicia sesión primero."); return; }
            const fecha = $("pFecha").value, motivo = $("pMotivo").value.trim();
            if (!fecha) { $("pMsg").innerHTML = msg("Elige la fecha."); return; }
            if (!motivo) { $("pMsg").innerHTML = msg("Describe brevemente el motivo."); return; }
            if (!fotoPermiso) { $("pMsg").innerHTML = msg("Adjunta la foto del comprobante de tutoría."); return; }
            if (!firmaTrazada) { $("pMsg").innerHTML = msg("Dibuja tu firma antes de enviar la solicitud."); return; }
            const solicitud = {
                matricula: tutorActual.hijo,
                tutorNombre: tutorActual.nombre,
                tutorEmail: tutorActual.email,
                fecha,
                tipo: $("pTipo").value,
                motivo,
                foto: fotoPermiso,
                firma: canvasFirma.toDataURL("image/png"),
                estado: "Pendiente"
            };
            permisos.push(solicitud);
            try {
                set("permisos", permisos);
            } catch (error) {
                permisos.pop();
                console.error("No se pudo guardar la solicitud de permiso.", error);
                $("pMsg").innerHTML = msg("No se pudo guardar la solicitud. El almacenamiento del navegador puede estar lleno; libera espacio e inténtalo otra vez.");
                return;
            }
            fotoPermiso = "";
            $("pFoto").value = "";
            $("pFotoVista").innerHTML = "";
            contextoFirma.clearRect(0, 0, canvasFirma.width, canvasFirma.height);
            firmaTrazada = false;
            $("pMotivo").value = "";
            $("pMsg").innerHTML = msg("✅ Solicitud enviada a Dirección para revisión.");
            entrarTutor(tutorActual);
        };

        /* Eventos de Estudiante */
        function entrarEstudiante(e) {
            generarQR(e);
            $("eInfo").innerHTML = info(e.matricula);
            $("loginEstudianteMensaje").innerHTML = ""; $("registroEstudiante").innerHTML = "";
            vistas.estudiante.entrar();
            actualizarEstadisticas();
        }
        E.log.querySelector("button.accion").onclick = () => {
            const val = $("loginMatricula").value.trim(), pass = $("loginPassword").value;
            const e = estudiantes.find(x => ((x.correo || "").toLowerCase() === val.toLowerCase() || x.matricula === val) && x.password === pass);
            if (e) { entrarEstudiante(e); return; }
            if (cuentaOk("estudiante", val, pass)) {
                $("correoEstudiante").value = val; $("passwordEstudiante").value = pass;
                $("loginEstudianteMensaje").innerHTML = ""; vistas.estudiante.perfil(); return;
            }
            $("loginEstudianteMensaje").innerHTML = msg("❌ Datos incorrectos.");
        };
        E.reg.querySelector("button.accion").onclick = () => {
            const v = id => $(id).value.trim();
            const nombre = v("nombreEstudiante"), correo = v("correoEstudiante"), matricula = v("matriculaEstudiante"),
                  grupo = v("grupoEstudiante"), esp = v("especialidadEstudiante"), tutor = v("tutorEstudiante"), password = $("passwordEstudiante").value;
            if (!nombre || !correo || !matricula || !grupo || !esp || !password) { $("registroEstudiante").innerHTML = msg("Completa todos los campos requeridos."); return; }
            if (estudiantes.some(x => x.matricula === matricula)) { $("registroEstudiante").innerHTML = msg("Esa matrícula ya está registrada."); return; }
            if (estudiantes.some(x => x.correo && x.correo.toLowerCase() === correo.toLowerCase())) { $("registroEstudiante").innerHTML = msg("Ese correo ya está registrado."); return; }
            const e = { nombre, correo, matricula, grupo, especialidad: esp, tutor, password };
            estudiantes.push(e); set("estudiantes", estudiantes);
            syncCuenta("estudiante", correo, password);
            entrarEstudiante(e);
        };

        /* Menú principal por tipo de usuario */
        const menu = document.createElement("div"); menu.id = "menuPrincipal";
        const menuIntro = document.createElement("div");
        menuIntro.className = "menu-intro";
        menuIntro.innerHTML = "<h2>¿Cómo quieres ingresar?</h2><p>Elige tu perfil para continuar.</p>";
        menu.appendChild(menuIntro);
        menu.innerHTML +=
            '<button class="cuadro" type="button" data-mod="estudiante"><span class="cuadro-icono" aria-hidden="true">🎓</span><span class="cuadro-titulo">Alumno</span><small>Credencial y asistencia</small></button>' +
            '<button class="cuadro" type="button" data-mod="tutor"><span class="cuadro-icono" aria-hidden="true">👪</span><span class="cuadro-titulo">Padre o tutor</span><small>Asistencia, faltas y permisos</small></button>' +
            '<button class="cuadro" type="button" data-mod="maestro"><span class="cuadro-icono" aria-hidden="true">📘</span><span class="cuadro-titulo">Maestro</span><small>Lista de alumnos y asistencia</small></button>' +
            '<button class="cuadro" type="button" data-mod="escuela"><span class="cuadro-icono" aria-hidden="true">🏫</span><span class="cuadro-titulo">Dirección</span><small>Alumnos, avisos, permisos y faltas</small></button>' +
            '<button class="cuadro" type="button" data-mod="entrada"><span class="cuadro-icono" aria-hidden="true">📷</span><span class="cuadro-titulo">Entrada</span><small>Registro mediante QR</small></button>';
        
        const barra = document.createElement("div"); barra.id = "barraVolver";
        barra.innerHTML = '<button id="btnVolver">← Volver</button><h2 id="tituloActual"></h2>';
        
        const avisoDemo = cont.querySelector(".aviso-demo");
        cont.insertBefore(barra, avisoDemo ? avisoDemo.nextSibling : cont.firstChild);
        cont.insertBefore(menu, barra.nextSibling);
        document.querySelectorAll(".modulo").forEach(m => m.classList.remove("activo"));

        const nombres = { estudiante: "Alumno", tutor: "Padre o tutor", maestro: "Maestro", escuela: "Dirección", entrada: "Entrada" };
        menu.querySelectorAll(".cuadro").forEach(btn => btn.onclick = () => {
            const id = btn.dataset.mod;
            menu.style.display = "none"; barra.style.display = "flex";
            $("tituloActual").textContent = nombres[id];
            document.querySelectorAll(".modulo").forEach(m => m.classList.remove("activo"));
            $(id).classList.add("activo");
            vistas[id].login();
            window.scrollTo(0, 0);
        });
        
        $("btnVolver").onclick = () => {
            document.querySelectorAll(".modulo").forEach(m => m.classList.remove("activo"));
            Object.values(vistas).forEach(v => v.login());
            cont.querySelectorAll("input").forEach(i => i.value = "");
            fotoPermiso = "";
            $("pFotoVista").innerHTML = "";
            $("pMotivo").value = "";
            $("pMsg").innerHTML = "";
            contextoFirma.clearRect(0, 0, canvasFirma.width, canvasFirma.height);
            firmaTrazada = false;
            maestroActual = null; tutorActual = null;
            detenerLector();
            barra.style.display = "none"; menu.style.display = "grid";
        };

        actualizarTabla();
        actualizarEstadisticas();
    }

    configurarInstalacion();
    window.addEventListener("load", iniciar);
})();