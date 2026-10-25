/* RECUPERA · configuracion de entorno.
   Este archivo NO forma parte del SHA del artefacto: es lo unico que cambia
   entre modo local, QA y produccion. Se reemplaza en el hosting, sin tocar
   index.html.

   HOY (Bloque 1) queda declarado en local: la app no toca la nube.
   En el Bloque 4, cuando RLS este verificado, se reemplaza por:

     window.RECUPERA_CONFIG = {
       url:     "https://TU-PROYECTO.supabase.co",
       anonKey: "sb_publishable_...",
       entorno: "produccion"
     };
*/
window.RECUPERA_CONFIG = { entorno: "local" };
