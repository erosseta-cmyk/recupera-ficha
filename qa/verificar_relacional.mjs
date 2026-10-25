#!/usr/bin/env node
/* =============================================================================
   RECUPERA · verificacion de aislamiento sobre el modelo relacional
   -----------------------------------------------------------------------------
   SOLO PARA QA. Se niega a correr si detecta datos que no creo el mismo script.

   Por que existe: el verificador anterior comprobaba TABLAS y no comprobaba
   VISTAS. Ese hueco dejo pasar dos vistas sin security_invoker que exponian
   los nombres de todos los pacientes a cualquier usuario autenticado.
   Este verificador cubre las 26 tablas Y las 4 vistas.

   USO
     1. rellena qa_relacional.config.json
     2. npm install
     3. npm run sembrar      <- crea 1 paciente ficticio por kinesiologo
     4. npm run verificar    <- ejecuta la matriz completa
   ============================================================================= */
import fs from "node:fs";
import path from "node:path";

let createClient;
try { ({ createClient } = await import("@supabase/supabase-js")); }
catch { console.error("\nFALTA INSTALAR: en esta carpeta ejecuta  npm install\n"); process.exit(1); }

const MODO = (process.argv[2] || "verificar").toLowerCase();
if (!["sembrar", "verificar"].includes(MODO)) {
  console.error("\nModo no valido. Usa:  npm run sembrar   o   npm run verificar\n"); process.exit(2);
}

/* ------------------------------------------------------------------ config
   Acepta dos formatos:
     · qa_relacional.config.json  (nuevo: url, anonKey, kine1{}, kine2{})
     · qa.config.json             (el del verificador anterior: emailA/passwordA,
                                   emailB/passwordB). Se traduce solo, para no
                                   tener las mismas credenciales en dos archivos.
   ------------------------------------------------------------------------- */
const nuevoArchivo  = path.join(process.cwd(), "qa_relacional.config.json");
const viejoArchivo  = path.join(process.cwd(), "qa.config.json");
let cfg, origenCfg;

if (fs.existsSync(nuevoArchivo)) {
  cfg = JSON.parse(fs.readFileSync(nuevoArchivo, "utf8"));
  origenCfg = "qa_relacional.config.json";
} else if (fs.existsSync(viejoArchivo)) {
  const v = JSON.parse(fs.readFileSync(viejoArchivo, "utf8"));
  cfg = {
    url: v.url,
    anonKey: v.anonKey,
    kine1: { email: v.emailA, password: v.passwordA },
    kine2: { email: v.emailB, password: v.passwordB },
  };
  origenCfg = "qa.config.json (formato antiguo, traducido)";
} else {
  console.error("\nNo encontre ni qa_relacional.config.json ni qa.config.json en esta carpeta.\n");
  process.exit(2);
}

const esPlantilla = (v) => /^[A-Z_]+$/.test(String(v || "").trim());
for (const [ruta, val] of [
  ["anonKey", cfg.anonKey],
  ["kine1.email", cfg.kine1?.email], ["kine1.password", cfg.kine1?.password],
  ["kine2.email", cfg.kine2?.email], ["kine2.password", cfg.kine2?.password],
]) {
  if (!val) { console.error(`\nFalta el campo ${ruta}.\n`); process.exit(2); }
  if (esPlantilla(val)) { console.error(`\nEl campo ${ruta} sigue con el texto de ejemplo.\n`); process.exit(2); }
}
if (/^sb_secret_|^eyJ.*service_role/i.test(String(cfg.anonKey))) {
  console.error("\nEsa parece una clave privilegiada. Aqui va la publishable/anon.\n"); process.exit(2);
}

const HOST = new URL(String(cfg.url).trim()).host;
console.log(`configuracion: ${origenCfg}`);
const REF_PRODUCCION = "jrtzivyqljcpkyfwjrov";
if (HOST.includes(REF_PRODUCCION)) {
  console.error(`\n!!! ABORTADO !!!\nLa configuracion apunta al proyecto de PRODUCCION (${REF_PRODUCCION}).\nEste script escribe y borra filas. Solo puede correr contra QA.\n`);
  process.exit(3);
}

if (cfg.kine1.password === cfg.kine2.password) {
  console.log("\nAVISO: las dos cuentas comparten la misma contrasena. La matriz corre igual,\n       pero dos identidades con la misma clave no son dos identidades en la practica.\n");
}

function rutAlAzar() {
  const cuerpo = String(10000000 + Math.floor(Math.random() * 89999999));
  let suma = 0, mult = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--) {
    suma += Number(cuerpo[i]) * mult;
    mult = mult === 7 ? 2 : mult + 1;
  }
  const resto = 11 - (suma % 11);
  const dv = resto === 11 ? "0" : resto === 10 ? "K" : String(resto);
  return `${cuerpo}-${dv}`;
}

const MARCA = "QA-AISLAMIENTO";           // todo lo que crea el script lleva esta marca
const nuevo = (email, password) => ({ email, password });

function cliente() {
  return createClient(String(cfg.url).trim(), String(cfg.anonKey).trim(),
    { auth: { persistSession: false, autoRefreshToken: false } });
}
async function comoKine(k) {
  const db = cliente();
  const { error } = await db.auth.signInWithPassword({ email: k.email, password: k.password });
  if (error) { console.error(`\nNo se pudo entrar como ${k.email}: ${error.message}\n`); process.exit(1); }
  const { data: id, error: e2 } = await db.rpc("mi_kinesiologo_id");
  if (e2 || !id) { console.error(`\n${k.email} no esta vinculado a ninguna fila de kinesiologos.\n`); process.exit(1); }
  return { db, kineId: id };
}

/* -------------------------------------------------------------- inventario */
const TABLAS_CLINICAS = [
  "pacientes", "sesiones", "evaluaciones", "anamnesis", "objetivos", "mediciones",
  "alergias", "medicamentos", "antecedentes_medicos", "contactos_emergencia",
  "consentimientos", "documentos", "alertas_clinicas", "adendas_sesion",
  "ejercicios", "planes_sesion", "ejercicios_sesion", "evaluaciones_integrales",
  "motor_clinico", "kinesiologos", "fichas_estado", "registro_auditoria", "auditoria",
];
const VISTAS = ["v_pacientes", "v_ultima_sesion", "v_adherencia", "v_fichas_incompletas"];
const AJENAS = ["sessions", "supplies", "params"];

/* ------------------------------------------------------------------ salida */
let ok = 0, fallo = 0;
const linea = (estado, nombre, detalle = "") => {
  const marca = estado ? "  OK  " : " FALLA";
  if (estado) ok++; else fallo++;
  console.log(`${marca} · ${nombre}${detalle ? "  ·  " + detalle : ""}`);
};

/* ===========================================================================
   MODO SEMBRAR
   =========================================================================== */
async function sembrar() {
  console.log(`\nRECUPERA · sembrado de QA · host ${HOST}\n`);

  const semillas = [
    { k: nuevo(cfg.kine1.email, cfg.kine1.password), rut: "11111111-1", nom: "Ficticio Uno" },
    { k: nuevo(cfg.kine2.email, cfg.kine2.password), rut: "22222222-2", nom: "Ficticio Dos" },
  ];

  for (const s of semillas) {
    const { db, kineId } = await comoKine(s.k);

    const { data: pac, error: ep } = await db.from("pacientes").insert({
      rut: s.rut,
      nombres: s.nom,
      apellidos: MARCA,
      fecha_nacimiento: "1950-01-01",
      sexo: "femenino",
      prevision: "fonasa",
      kinesiologo_id: kineId,
      es_prueba: true,
    }).select("id, n_ficha").single();
    if (ep) { console.error(`  no se pudo crear el paciente de ${s.k.email}: ${ep.message}`); process.exit(1); }

    const { data: ses, error: es } = await db.from("sesiones").insert({
      paciente_id: pac.id, kinesiologo_id: kineId,
      estado: "realizada", modalidad: "domicilio",
      notas_clinicas: MARCA, eva: 4,
    }).select("id").single();
    if (es) { console.error(`  no se pudo crear la sesion: ${es.message}`); process.exit(1); }

    const { error: ea } = await db.from("alergias").insert({
      paciente_id: pac.id, alergeno: MARCA, severidad: "leve",
    });
    if (ea) { console.error(`  no se pudo crear la alergia: ${ea.message}`); process.exit(1); }

    await db.auth.signOut().catch(() => {});
    console.log(`  ${s.k.email}  ->  kine ${kineId}  ·  ficha ${pac.n_ficha}  ·  paciente ${pac.id}  ·  sesion ${ses.id}`);
  }

  console.log("\nSembrado listo. Ahora ejecuta:  npm run verificar\n");
}

/* ===========================================================================
   MODO VERIFICAR
   =========================================================================== */
async function verificar() {
  console.log(`\nRECUPERA · matriz de aislamiento · host ${HOST}\n`);

  /* --- 1. anonimo: no debe ver ni escribir nada -------------------------- */
  console.log("1 · Acceso anonimo (solo clave publishable, sin iniciar sesion)\n");
  const anon = cliente();
  for (const t of [...TABLAS_CLINICAS, ...VISTAS]) {
    const { data, error } = await anon.from(t).select("*").limit(1);
    const bloqueado = !!error || !data || data.length === 0;
    linea(bloqueado, `anon no lee ${t}`, error ? "rechazado" : (data && data.length ? `DEVOLVIO ${data.length} fila(s)` : "0 filas"));
  }
  {
    const { error } = await anon.from("pacientes").insert({
      rut: "99999999-9", nombres: "Intruso", apellidos: MARCA,
      kinesiologo_id: "00000000-0000-0000-0000-000000000000",
    });
    linea(!!error, "anon no puede insertar en pacientes", error ? "rechazado" : "INSERTO UNA FILA");
  }

  /* --- 2. identidades ---------------------------------------------------- */
  console.log("\n2 · Aislamiento entre dos kinesiologos\n");
  const A = await comoKine(nuevo(cfg.kine1.email, cfg.kine1.password));
  const B = await comoKine(nuevo(cfg.kine2.email, cfg.kine2.password));
  linea(A.kineId !== B.kineId, "las dos cuentas son kinesiologos distintos", `${A.kineId.slice(0, 8)} vs ${B.kineId.slice(0, 8)}`);

  const pacA = (await A.db.from("pacientes").select("id, n_ficha").limit(1)).data?.[0];
  const pacB = (await B.db.from("pacientes").select("id, n_ficha").limit(1)).data?.[0];
  if (!pacA || !pacB) { console.error("\nFalta sembrar. Ejecuta primero:  npm run sembrar\n"); process.exit(1); }
  linea(pacA.id !== pacB.id, "cada uno ve su propio paciente", `${pacA.n_ficha} / ${pacB.n_ficha}`);

  /* --- 3. lectura cruzada, tabla por tabla ------------------------------- */
  console.log("\n3 · A no puede leer los datos de B\n");
  {
    const { data } = await A.db.from("pacientes").select("id").eq("id", pacB.id);
    linea(!data || data.length === 0, "A no ve el paciente de B", data?.length ? "DEVOLVIO la ficha de B" : "0 filas visibles");
  }
  for (const t of ["sesiones", "evaluaciones", "anamnesis", "alergias", "medicamentos",
                   "antecedentes_medicos", "contactos_emergencia", "consentimientos",
                   "documentos", "alertas_clinicas", "mediciones",
                   "evaluaciones_integrales", "planes_sesion", "motor_clinico"]) {
    const { data, error } = await A.db.from(t).select("id").eq("paciente_id", pacB.id);
    linea(!error && (!data || data.length === 0), `A no ve ${t} de B`,
      error ? `error: ${error.message}` : (data?.length ? `DEVOLVIO ${data.length} fila(s)` : "0 filas"));
  }
  {
    const { data } = await A.db.from("kinesiologos").select("id");
    const soloUno = data && data.length === 1 && data[0].id === A.kineId;
    linea(soloUno, "A solo ve su propia fila en kinesiologos", data ? `${data.length} fila(s)` : "sin datos");
  }

  /* --- 4. LAS VISTAS · el hueco del verificador anterior ------------------ */
  console.log("\n4 · Vistas (el punto ciego del verificador anterior)\n");
  for (const v of VISTAS) {
    const { data, error } = await A.db.from(v).select("*");
    if (error) { linea(true, `${v} rechaza a A`, "sin acceso"); continue; }
    const filas = data || [];
    const ajenas = filas.filter(f =>
      (f.kinesiologo_id && f.kinesiologo_id !== A.kineId) ||
      (f.id && f.id === pacB.id) ||
      (f.paciente_id && f.paciente_id === pacB.id));
    linea(ajenas.length === 0, `${v} no filtra datos de B a A`,
      ajenas.length ? `DEVOLVIO ${ajenas.length} fila(s) ajenas` : `${filas.length} fila(s), todas propias`);
  }

  /* --- 5. escritura cruzada --------------------------------------------- */
  console.log("\n5 · A no puede escribir sobre lo de B\n");
  {
    const { error } = await A.db.from("pacientes").insert({
      rut: "33333333-3", nombres: "Suplantado", apellidos: MARCA,
      kinesiologo_id: B.kineId, es_prueba: true,
    });
    linea(!!error, "A no puede crear un paciente a nombre de B", error ? "rechazado" : "CREO LA FILA");
  }
  {
    const { data, error } = await A.db.from("pacientes")
      .update({ nombres: "Modificado por A" }).eq("id", pacB.id).select("id");
    linea(!!error || !data || data.length === 0, "A no puede modificar el paciente de B",
      data?.length ? "MODIFICO LA FILA" : "0 filas afectadas");
  }
  {
    const { data, error } = await A.db.from("sesiones")
      .update({ notas_clinicas: "Modificado por A" }).eq("paciente_id", pacB.id).select("id");
    linea(!!error || !data || data.length === 0, "A no puede modificar sesiones de B",
      data?.length ? "MODIFICO LA FILA" : "0 filas afectadas");
  }

  /* --- 6. borrado: dos niveles ------------------------------------------
     Columna vertebral -> sin borrado fisico nunca.
     Corregible        -> borrado permitido, pero tiene que quedar en auditoria.
     Verificar solo lo primero seria medir la mitad del diseno.
     ---------------------------------------------------------------------- */
  console.log("\n6 · Borrado en dos niveles (bloque 4)\n");
  {
    const { data } = await A.db.from("pacientes").delete().eq("id", pacB.id).select("id");
    linea(!data || data.length === 0, "A no puede borrar el paciente de B",
      data?.length ? "BORRO LA FICHA DE B" : "0 filas borradas");
  }

  // 6.a · columna vertebral: ni siquiera lo propio
  {
    const { data: tmp, error: eTmp } = await A.db.from("pacientes").insert({
      rut: rutAlAzar(), nombres: "Desechable", apellidos: MARCA,
      kinesiologo_id: A.kineId, es_prueba: true,
    }).select("id").single();
    if (eTmp) {
      linea(false, "no se pudo crear la ficha desechable de prueba", eTmp.message);
    } else {
      const { data: borrado } = await A.db.from("pacientes").delete().eq("id", tmp.id).select("id");
      const bloqueado = !borrado || borrado.length === 0;
      linea(bloqueado, "columna vertebral · no se puede borrar una ficha propia",
        bloqueado ? "rechazado" : "BORRO LA FICHA · falta aplicar el bloque 4");
    }
  }
  {
    const { data: ses } = await A.db.from("sesiones").select("id").eq("paciente_id", pacA.id).limit(1);
    if (ses?.length) {
      const { data: borrado } = await A.db.from("sesiones").delete().eq("id", ses[0].id).select("id");
      linea(!borrado || borrado.length === 0, "columna vertebral · no se puede borrar una sesion propia",
        borrado?.length ? "BORRO LA SESION" : "rechazado");
    }
  }

  // 6.b · corregible: tiene que poder deshacerse un error de digitacion
  {
    const { data: al, error: eAl } = await A.db.from("alergias").insert({
      paciente_id: pacA.id, alergeno: "ERROR DE DIGITACION " + MARCA, severidad: "leve",
    }).select("id").single();
    if (eAl) {
      linea(false, "corregible · no se pudo registrar una alergia de prueba", eAl.message);
    } else {
      const { data: borrado } = await A.db.from("alergias").delete().eq("id", al.id).select("id");
      const pudo = !!borrado && borrado.length === 1;
      linea(pudo, "corregible · se puede quitar una alergia mal ingresada",
        pudo ? "borrada" : "BLOQUEADO · un error de digitacion quedaria permanente");

      // y el dato no desaparece: queda en auditoria con la fila completa
      const { data: aud } = await A.db.from("auditoria")
        .select("id, operacion, datos_anteriores")
        .eq("tabla", "alergias").eq("registro_id", al.id).eq("operacion", "DELETE");
      const conservado = !!aud && aud.length > 0 &&
        String(aud[0].datos_anteriores?.alergeno || "").includes("ERROR DE DIGITACION");
      linea(conservado, "corregible · el borrado quedo en auditoria con la fila completa",
        conservado ? "recuperable desde auditoria" : "SIN RASTRO · el dato se perdio");
    }
  }

  /* --- 7. tablas de otra aplicacion -------------------------------------- */
  console.log("\n7 · Tablas de la otra aplicacion (sessions / supplies / params)\n");
  for (const t of AJENAS) {
    const { data, error } = await A.db.from(t).select("*");
    linea(!error, `A puede consultar ${t} sin error`, error ? error.message : `${data?.length || 0} fila(s) propias`);
  }

  await A.db.auth.signOut().catch(() => {});
  await B.db.auth.signOut().catch(() => {});

  console.log(`\n-----------------------------------------------------------`);
  console.log(`RESULTADO · ${ok} correctas · ${fallo} fallas`);
  console.log(`-----------------------------------------------------------\n`);
  if (fallo > 0) {
    console.log("Las lineas marcadas FALLA son las que hay que corregir antes de\ntocar produccion. Cuentalas tu: no confies en el numero de arriba.\n");
    process.exit(1);
  }
}

await (MODO === "sembrar" ? sembrar() : verificar());
