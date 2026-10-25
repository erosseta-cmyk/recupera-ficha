-- =============================================================================
-- RECUPERA v5.4.0 · P3 · Esquema y politicas RLS
-- -----------------------------------------------------------------------------
-- Aplicar en el proyecto Supabase (SQL Editor) ANTES de cualquier prueba cloud.
-- Idempotente: se puede ejecutar varias veces.
--
-- Modelo de amenaza que cubre este archivo:
--   La clave publishable es publica por diseno y hoy ya circula fuera de tu
--   control. Por lo tanto la UNICA barrera entre un tercero y las fichas es
--   este archivo. Si algo aqui esta mal, no hay segunda linea de defensa.
--
-- Lo que este archivo NO resuelve, y debes decidir aparte:
--   `fichas_estado.estado` se almacena como JSON legible por el proyecto. No hay
--   cifrado extremo a extremo de aplicacion. Cualquiera con acceso administrativo
--   al proyecto Supabase puede leer fichas clinicas. Esa es una decision de
--   custodia, no un detalle tecnico.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tablas
-- ---------------------------------------------------------------------------
create table if not exists public.kinesiologos (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null unique references auth.users(id) on delete cascade,
  nombre      text,
  creado_en   timestamptz not null default now()
);

create table if not exists public.fichas_estado (
  kinesiologo_id uuid primary key references public.kinesiologos(id) on delete cascade,
  estado         jsonb not null,
  updated_at     timestamptz not null default now()
);

create table if not exists public.registro_auditoria (
  id             bigserial primary key,
  kinesiologo_id uuid not null references public.kinesiologos(id) on delete cascade,
  paciente_ref   text,
  evento         text not null,
  detalle        jsonb not null default '{}'::jsonb,
  creado_en      timestamptz not null default now(),
  recibido_en    timestamptz not null default now()
);

create index if not exists ix_auditoria_kine_fecha
  on public.registro_auditoria (kinesiologo_id, creado_en desc);

-- ---------------------------------------------------------------------------
-- 2. Identidad del tratante · fail-closed
--    La app llama a esta RPC y BLOQUEA la sincronizacion si no devuelve fila.
--    SECURITY DEFINER con search_path fijo: sin esto es un vector de escalada.
-- ---------------------------------------------------------------------------
create or replace function public.mi_kinesiologo_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select k.id from public.kinesiologos k where k.user_id = auth.uid();
$$;

revoke all on function public.mi_kinesiologo_id() from public, anon;
grant execute on function public.mi_kinesiologo_id() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. RLS activo y forzado en las tres tablas
--    `force row level security` tambien somete al DUENO de la tabla. Sin esto,
--    cualquier conexion que resuelva como owner ignora las politicas.
-- ---------------------------------------------------------------------------
alter table public.kinesiologos       enable row level security;
alter table public.fichas_estado      enable row level security;
alter table public.registro_auditoria enable row level security;
alter table public.kinesiologos       force  row level security;
alter table public.fichas_estado      force  row level security;
alter table public.registro_auditoria force  row level security;

-- ---------------------------------------------------------------------------
-- 4. Nada para anonimos. La clave publishable sola no abre ninguna puerta.
-- ---------------------------------------------------------------------------
revoke all on public.kinesiologos       from anon;
revoke all on public.fichas_estado      from anon;
revoke all on public.registro_auditoria from anon;

grant select                       on public.kinesiologos       to authenticated;
grant select, insert, update       on public.fichas_estado      to authenticated;
grant insert, select               on public.registro_auditoria to authenticated;
-- Deliberadamente SIN delete en ninguna de las tres.
revoke delete on public.fichas_estado      from authenticated;
revoke delete on public.registro_auditoria from authenticated;
revoke update on public.registro_auditoria from authenticated;

-- ---------------------------------------------------------------------------
-- 5. Politicas
-- ---------------------------------------------------------------------------
drop policy if exists kine_ve_su_fila on public.kinesiologos;
create policy kine_ve_su_fila on public.kinesiologos
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists ficha_select_propia on public.fichas_estado;
create policy ficha_select_propia on public.fichas_estado
  for select to authenticated
  using (kinesiologo_id = public.mi_kinesiologo_id());

drop policy if exists ficha_insert_propia on public.fichas_estado;
create policy ficha_insert_propia on public.fichas_estado
  for insert to authenticated
  with check (kinesiologo_id = public.mi_kinesiologo_id());

-- USING controla que filas puede tocar; WITH CHECK impide reasignar la fila a
-- otro tratante en el mismo UPDATE. Faltando el segundo, B puede robarse A.
drop policy if exists ficha_update_propia on public.fichas_estado;
create policy ficha_update_propia on public.fichas_estado
  for update to authenticated
  using      (kinesiologo_id = public.mi_kinesiologo_id())
  with check (kinesiologo_id = public.mi_kinesiologo_id());

drop policy if exists auditoria_insert_propia on public.registro_auditoria;
create policy auditoria_insert_propia on public.registro_auditoria
  for insert to authenticated
  with check (kinesiologo_id = public.mi_kinesiologo_id());

drop policy if exists auditoria_select_propia on public.registro_auditoria;
create policy auditoria_select_propia on public.registro_auditoria
  for select to authenticated
  using (kinesiologo_id = public.mi_kinesiologo_id());

-- ---------------------------------------------------------------------------
-- 6. Auditoria realmente append-only
--    Sin este trigger, `creado_en` lo pone el cliente y es falsificable.
-- ---------------------------------------------------------------------------
create or replace function public.auditoria_sella()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.recibido_en := now();
  new.kinesiologo_id := public.mi_kinesiologo_id();
  if new.kinesiologo_id is null then
    raise exception 'auditoria sin tratante autenticado';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_auditoria_sella on public.registro_auditoria;
create trigger trg_auditoria_sella
  before insert on public.registro_auditoria
  for each row execute function public.auditoria_sella();

-- ---------------------------------------------------------------------------
-- 7. updated_at del lado servidor
--    v5.3.12 usaba un `updated_at` generado por el CLIENTE como testigo de
--    concurrencia optimista. Un reloj desfasado rompe la guarda. Aqui lo sella
--    el servidor y el cliente solo lo lee.
-- ---------------------------------------------------------------------------
create or replace function public.ficha_sella()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

drop trigger if exists trg_ficha_sella on public.fichas_estado;
create trigger trg_ficha_sella
  before insert or update on public.fichas_estado
  for each row execute function public.ficha_sella();

-- =============================================================================
-- VERIFICACION · ejecutar y leer los resultados, no asumirlos
-- =============================================================================

-- 7.1 · RLS activo y forzado en las tres tablas (esperado: 3 filas, t / t)
select relname, relrowsecurity, relforcerowsecurity
from pg_class
where relname in ('kinesiologos','fichas_estado','registro_auditoria');

-- 7.2 · politicas presentes (esperado: 7)
select tablename, policyname, cmd
from pg_policies
where schemaname='public'
order by tablename, policyname;

-- 7.3 · el rol anon no debe tener NINGUN privilegio (esperado: 0 filas)
select table_name, privilege_type
from information_schema.role_table_grants
where grantee='anon' and table_schema='public';

-- 7.4 · ninguna politica debe permitir update sin with check (esperado: 0 filas)
select tablename, policyname
from pg_policies
where schemaname='public' and cmd='UPDATE' and with_check is null;
