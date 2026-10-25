#!/usr/bin/env node
/* =============================================================================
   RECUPERA · verificador de RLS  ·  se ejecuta fuera del navegador
   -----------------------------------------------------------------------------
   Responde con evidencia dos preguntas:
     1. La clave publishable, que es publica por diseno, ¿abre alguna puerta?
     2. ¿Un kinesiologo puede ver, modificar o suplantar a otro?

   COMO SE USA (Windows, macOS o Linux, igual en los tres)
     1. Abre `qa.config.json` con el Bloc de notas y rellena los seis valores.
     2. En esta carpeta, abre una terminal y escribe:  npm install
     3. Despues:  npm run verificar

   NO se ejecuta contra produccion: exige "dedicado": "YES" en el archivo de
   configuracion y aborta si detecta una clave privilegiada. No imprime
   credenciales. Escribe resultado_rls.json y termina con codigo 1 si algo falla.

   `qa.config.json` CONTIENE CONTRASENAS. No lo subas a Netlify, ni a GitHub,
   ni lo envies por correo.
   ============================================================================= */
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

/* Configuracion: primero qa.config.json, y si no existe, variables de entorno. */
function leerConfig() {
  const archivo = path.join(process.cwd(), "qa.config.json");
  if (fs.existsSync(archivo)) {
    try {
      const c = JSON.parse(fs.readFileSync(archivo, "utf8"));
      return {
        RECUPERA_QA_URL: c.url, RECUPERA_QA_ANON_KEY: c.anonKey,
        RECUPERA_QA_EMAIL_A: c.emailA, RECUPERA_QA_PASSWORD_A: c.passwordA,
        RECUPERA_QA_EMAIL_B: c.emailB, RECUPERA_QA_PASSWORD_B: c.passwordB,
        RECUPERA_QA_DEDICADO: c.dedicado,
      };
    } catch (e) {
      console.error("\nqa.config.json existe pero no se pudo leer: " + e.message);
      console.error("Revisa que no falte una coma o unas comillas.\n");
      process.exit(2);
    }
  }
  return process.env;
}

const E = leerConfig();
const QA_URL = (E.RECUPERA_QA_URL || "").trim().replace(/\/+$/, "");
const ANON = (E.RECUPERA_QA_ANON_KEY || "").trim();
const A = { email: E.RECUPERA_QA_EMAIL_A, pass: E.RECUPERA_QA_PASSWORD_A };
const B = { email: E.RECUPERA_QA_EMAIL_B, pass: E.RECUPERA_QA_PASSWORD_B };

function abortar(m) { console.error("\nBLOQUEANTE: " + m + "\n"); process.exit(2); }
if (E.RECUPERA_QA_DEDICADO !== "YES") abortar("falta \"dedicado\": \"YES\" en qa.config.json. Este script no corre contra un proyecto que no declaraste como QA.");
if (!/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(QA_URL)) abortar("la URL del proyecto QA falta o esta mal escrita. Debe ser https://algo.supabase.co, sin barra final.");
if (/^sb_secret_/i.test(ANON)) abortar("la clave entregada es un secreto privilegiado. Este script solo acepta anon/publishable.");
if (ANON.startsWith("ey")) {
  try {
    const p = JSON.parse(Buffer.from(ANON.split(".")[1], "base64").toString());
    if (String(p.role).toLowerCase() === "service_role") abortar("la clave entregada es service_role. Nunca en un cliente.");
  } catch { /* no es JWT */ }
}
if (!A.email || !A.pass || !B.email || !B.pass) abortar("faltan las dos cuentas de prueba (A y B) o sus contrasenas.");
if (A.email === B.email) abortar("A y B son el mismo correo: la prueba de aislamiento no probaria nada.");

/* Mismo defecto que ya corregimos en la app (E-16): una plantilla sin rellenar
   parecia valida y el script moria con "fetch failed" en vez de decir que falta
   completar el archivo. */
const PLANTILLA = /PEGA|AQUI|AQUÍ|TU-PROYECTO|TU_PROYECTO|CAMBIAR|XXXX|\.\.\./i;
for (const [campo, valor] of [["url", QA_URL], ["anonKey", ANON],
     ["emailA", A.email], ["passwordA", A.pass], ["emailB", B.email], ["passwordB", B.pass]]) {
  if (PLANTILLA.test(String(valor || ""))) {
    abortar(`el campo "${campo}" de qa.config.json sigue con el texto de ejemplo. Rellena los seis valores y guarda el archivo.`);
  }
}

const SUFIJO = "QA-STG-" + process.pid + "-" + Math.floor(Date.now() / 1000);
const R = [];
const anota = (id, desc, ok, detalle) => { R.push({ id, desc, ok, detalle: String(detalle ?? "").slice(0, 220) }); };
const cli = () => createClient(QA_URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });

async function entrar(c, cuenta, etq) {
  const { data, error } = await c.auth.signInWithPassword({ email: cuenta.email, password: cuenta.pass });
  if (error) abortar(`la cuenta ${etq} no pudo autenticarse: ${error.message}`);
  return data.user.id;
}

console.log("RECUPERA · verificacion de RLS");
console.log("host QA:", new URL(QA_URL).host, "· ids sinteticos:", SUFIJO, "\n");

/* ------------------------------------------------------------------ ANONIMO */
{
  const c = cli();
  for (const t of ["kinesiologos", "fichas_estado", "registro_auditoria"]) {
    const { data, error } = await c.from(t).select("*").limit(1);
    // correcto = error de permisos, o cero filas. Incorrecto = datos devueltos.
    const filas = data ? data.length : 0;
    anota(`ANON-SELECT-${t}`, `anonimo NO puede leer ${t}`,
      !!error || !filas, error ? error.message : (filas ? `DEVOLVIO ${filas} filas` : "0 filas visibles"));
  }
  const { error: eIns } = await c.from("registro_auditoria")
    .insert({ kinesiologo_id: "00000000-0000-0000-0000-000000000000", evento: SUFIJO + "-anon", detalle: {} });
  anota("ANON-INSERT-auditoria", "anonimo NO puede escribir auditoria", !!eIns, eIns ? eIns.message : "insercion ACEPTADA");

  const { error: eRpc } = await c.rpc("mi_kinesiologo_id");
  anota("ANON-RPC", "anonimo NO puede ejecutar mi_kinesiologo_id", !!eRpc, eRpc ? eRpc.message : "ejecucion ACEPTADA");
}

/* ------------------------------------------------------------- IDENTIDAD A/B */
const ca = cli(), cb = cli();
await entrar(ca, A, "A"); await entrar(cb, B, "B");

const { data: kaRaw, error: eKa } = await ca.rpc("mi_kinesiologo_id");
const { data: kbRaw, error: eKb } = await cb.rpc("mi_kinesiologo_id");
const ka = kaRaw ? String(kaRaw) : null, kb = kbRaw ? String(kbRaw) : null;
anota("ID-A", "A resuelve un tratante", !!ka, eKa ? eKa.message : ka ? "ok" : "sin fila en kinesiologos");
anota("ID-B", "B resuelve un tratante", !!kb, eKb ? eKb.message : kb ? "ok" : "sin fila en kinesiologos");
anota("ID-DISTINTA", "A y B son tratantes DISTINTOS", !!(ka && kb && ka !== kb), ka && kb ? (ka === kb ? "misma identidad" : "ok") : "identidad no resuelta");

if (!ka || !kb || ka === kb) {
  fs.writeFileSync("resultado_rls.json", JSON.stringify({ host: new URL(QA_URL).host, resultados: R }, null, 2));
  console.table(R.map(x => ({ id: x.id, ok: x.ok ? "PASA" : "FALLA", detalle: x.detalle })));
  abortar("sin dos identidades distintas no tiene sentido seguir. Vincula ambas cuentas en la tabla kinesiologos.");
}

/* ------------------------------------------------------- ESCRITURA Y LECTURA */
const marcaA = SUFIJO + "-A";
{
  const estado = { patients: { [marcaA]: { profile: { name: "Sintetico A" }, sessions: {} } }, __savedAt: new Date().toISOString() };
  const { data: hay } = await ca.from("fichas_estado").select("updated_at").eq("kinesiologo_id", ka).maybeSingle();
  const q = hay
    ? await ca.from("fichas_estado").update({ estado }).eq("kinesiologo_id", ka).select("updated_at")
    : await ca.from("fichas_estado").insert({ kinesiologo_id: ka, estado }).select("updated_at");
  anota("A-ESCRIBE", "A escribe su propia ficha", !q.error, q.error ? q.error.message : "ok");

  const { data: rel, error: eRel } = await ca.from("fichas_estado").select("estado,updated_at").eq("kinesiologo_id", ka).maybeSingle();
  anota("A-RELEE", "A relee lo que escribio", !eRel && !!(rel && rel.estado && rel.estado.patients && rel.estado.patients[marcaA]),
    eRel ? eRel.message : "ok");

  // el testigo de version lo sella el SERVIDOR, no el cliente
  const antes = rel && rel.updated_at;
  await new Promise(r => setTimeout(r, 1100));
  await ca.from("fichas_estado").update({ estado, updated_at: "1999-01-01T00:00:00Z" }).eq("kinesiologo_id", ka);
  const { data: post } = await ca.from("fichas_estado").select("updated_at").eq("kinesiologo_id", ka).maybeSingle();
  const sellado = post && post.updated_at && !String(post.updated_at).startsWith("1999");
  anota("SERVER-SELLA-updated_at", "el servidor sella updated_at e ignora el del cliente", !!sellado,
    sellado ? "trigger activo" : "el cliente pudo fijar updated_at (falta trg_ficha_sella)");
  void antes;
}

/* -------------------------------------------------------------- AISLAMIENTO */
{
  const { data, error } = await cb.from("fichas_estado").select("estado").eq("kinesiologo_id", ka).maybeSingle();
  anota("B-NO-LEE-A", "B NO puede leer la ficha de A", !!error || !data,
    error ? error.message : (data ? "DEVOLVIO la ficha de A" : "0 filas visibles"));

  const { data: upd, error: eUpd } = await cb.from("fichas_estado")
    .update({ estado: { patients: {}, invadido: true } }).eq("kinesiologo_id", ka).select("kinesiologo_id");
  anota("B-NO-MODIFICA-A", "B NO puede modificar la ficha de A", !!eUpd || !(upd && upd.length),
    eUpd ? eUpd.message : `modifico ${upd ? upd.length : 0} filas`);

  const { data: del, error: eDel } = await cb.from("fichas_estado").delete().eq("kinesiologo_id", ka).select("kinesiologo_id");
  anota("B-NO-BORRA-A", "B NO puede borrar la ficha de A", !!eDel || !(del && del.length),
    eDel ? eDel.message : `borro ${del ? del.length : 0} filas`);

  // suplantacion en auditoria: B intenta escribir atribuyendose A
  const { error: eSup } = await cb.from("registro_auditoria")
    .insert({ kinesiologo_id: ka, evento: SUFIJO + "-suplantacion", detalle: {} });
  let suplanto = false;
  if (!eSup) {
    const { data: v } = await ca.from("registro_auditoria").select("id,evento").eq("kinesiologo_id", ka).eq("evento", SUFIJO + "-suplantacion");
    suplanto = !!(v && v.length);            // el trigger puede haberla reasignado a B
  }
  anota("B-NO-SUPLANTA-A", "B NO puede insertar auditoria atribuida a A", !suplanto,
    eSup ? eSup.message : (suplanto ? "la fila quedo atribuida a A" : "rechazada o reasignada por el trigger"));

  // A no ve lo de B
  const marcaB = SUFIJO + "-B";
  await cb.from("registro_auditoria").insert({ kinesiologo_id: kb, evento: marcaB, detalle: {} });
  const { data: fuga } = await ca.from("registro_auditoria").select("id").eq("evento", marcaB);
  anota("A-NO-VE-B", "A NO ve la auditoria de B", !(fuga && fuga.length), `${fuga ? fuga.length : 0} filas visibles`);
}

/* --------------------------------------------- AUDITORIA REALMENTE APPEND-ONLY */
{
  const ev = SUFIJO + "-inmutable";
  await ca.from("registro_auditoria").insert({ kinesiologo_id: ka, evento: ev, detalle: {} });
  const { data: upd, error: eUpd } = await ca.from("registro_auditoria").update({ evento: ev + "-alterado" }).eq("evento", ev).select("id");
  anota("AUDITORIA-NO-UPDATE", "nadie puede modificar auditoria propia", !!eUpd || !(upd && upd.length),
    eUpd ? eUpd.message : `modifico ${upd ? upd.length : 0} filas`);
  const { data: del, error: eDel } = await ca.from("registro_auditoria").delete().eq("evento", ev).select("id");
  anota("AUDITORIA-NO-DELETE", "nadie puede borrar auditoria propia", !!eDel || !(del && del.length),
    eDel ? eDel.message : `borro ${del ? del.length : 0} filas`);
}

await ca.auth.signOut(); await cb.auth.signOut();

/* ---------------------------------------------------------------- RESULTADO */
const fallan = R.filter(x => !x.ok);
console.table(R.map(x => ({ id: x.id, resultado: x.ok ? "PASA" : "FALLA", detalle: x.detalle })));
fs.writeFileSync("resultado_rls.json", JSON.stringify({
  host: new URL(QA_URL).host, sufijoSintetico: SUFIJO, ejecutado: new Date().toISOString(),
  total: R.length, fallan: fallan.length, resultados: R
}, null, 2));

console.log(`\n${R.length - fallan.length}/${R.length} verificaciones pasan.`);
console.log(`Registros sinteticos creados con la marca ${SUFIJO}. Eliminalos desde el SQL Editor:`);
console.log(`  delete from public.registro_auditoria where evento like '${SUFIJO}%';`);
if (fallan.length) {
  console.log("\nFALLAN:");
  for (const f of fallan) console.log(`  · ${f.id} — ${f.desc} → ${f.detalle}`);
  console.log("\nNo continues con la puerta cloud ni con pacientes reales hasta que esto salga en cero.\n");
  process.exit(1);
}
console.log("\nRLS cerrado. Esto habilita seguir con la puerta cloud, no habilita pacientes reales.\n");
