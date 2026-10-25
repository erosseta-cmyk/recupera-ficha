/* ===========================================================================
   RECUPERA v5.4.0 · service worker
   ---------------------------------------------------------------------------
   Politica deliberada:
     - El DOCUMENTO va network-first. En una aplicacion clinica, servir un HTML
       cacheado significa que una correccion nunca llega al equipo de consulta.
       La cache del documento es solo respaldo para trabajar sin conexion.
     - `config.js` NUNCA se cachea: es lo que distingue QA de produccion.
     - `vendor/` va cache-first: esta fijado por SHA e integridad de subrecurso,
       es inmutable por definicion.
     - Nada de terceros. Cualquier peticion fuera del origen pasa de largo.
   =========================================================================== */
const CACHE = "recupera-v5-4-0";
const PRECARGA = ["./", "./manifest.json", "./vendor/supabase-js-2.112.3.umd.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECARGA)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // nada de terceros
  if (url.pathname.endsWith("/config.js")) return;          // entorno siempre fresco

  if (url.pathname.includes("/vendor/")) {                  // inmutable
    e.respondWith(caches.match(req).then((r) => r || fetch(req).then((resp) => {
      const copia = resp.clone();
      caches.open(CACHE).then((c) => c.put(req, copia));
      return resp;
    })));
    return;
  }

  // documento y resto: red primero, cache solo como respaldo sin conexion
  e.respondWith(
    fetch(req)
      .then((resp) => {
        const copia = resp.clone();
        caches.open(CACHE).then((c) => c.put(req, copia));
        return resp;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match("./")))
  );
});
