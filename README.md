# RECUPERA · Ficha clínica kinésica

Versión publicada en https://recupera-ficha.netlify.app (build v5.4.3).
Repositorio **privado**. Contiene código, no datos de pacientes.

- `app/`  lo que se sube a Netlify (arrastrar esta carpeta).
- `sql/`  esquema de la base y la conexión con Ascenso.
- `qa/`   verificadores de seguridad (RLS). Copia `qa.config.example.json` como `qa.config.json`;
          ese archivo tiene contraseñas y está excluido del repositorio.
- `docs/` mapa de campos.

Base de datos: Supabase, proyecto "recupera".
