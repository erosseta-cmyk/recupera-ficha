-- =============================================================================
-- RECUPERA · extension del esquema clinico  ·  v6
-- -----------------------------------------------------------------------------
-- Objetivo: que la interfaz y las automatizaciones del Sistema B funcionen
-- sobre el modelo relacional del Sistema A, sin degradar el modelo.
--
-- Todos los cambios son ADITIVOS o RELAJAN restricciones. Ninguno borra datos
-- ni columnas. Aun asi: NO lo ejecutes sin haber descargado antes el rescate
-- completo de las tablas.
--
-- ORDEN DE EJECUCION: las secciones 0 y 1 van SOLAS y primero. Postgres no
-- permite usar un valor de enum recien creado en la misma transaccion.
-- =============================================================================


-- =============================================================================
-- SECCION 0 · valores de enum nuevos   (EJECUTAR SOLA, LUEGO ESPERAR)
-- -----------------------------------------------------------------------------
-- La app mide Borg, saturacion, frecuencia cardiaca y presion. Con el enum
-- actual todos caerian en 'otra' y serian imposibles de graficar por separado.
-- =============================================================================
alter type tipo_metrica_enum add value if not exists 'borg';
alter type tipo_metrica_enum add value if not exists 'spo2';
alter type tipo_metrica_enum add value if not exists 'fc';
alter type tipo_metrica_enum add value if not exists 'pa_sistolica';
alter type tipo_metrica_enum add value if not exists 'pa_diastolica';
alter type tipo_metrica_enum add value if not exists 'peso';
alter type tipo_metrica_enum add value if not exists 'glicemia';
alter type tipo_metrica_enum add value if not exists 'adherencia';
alter type tipo_metrica_enum add value if not exists 'irf';

-- Motivo de inasistencia: sin esto puedes contar cuantas se perdieron,
-- pero no por que, que es lo unico que permite hacer algo al respecto.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'motivo_inasistencia_enum') then
    create type motivo_inasistencia_enum as enum
      ('olvido','salud','transporte','trabajo','clima','economico','sin_aviso','otro');
  end if;
end $$;


-- =============================================================================
-- SECCION 1 · ficha progresiva sin ficha invisible
-- -----------------------------------------------------------------------------
-- Decision 1: se puede ingresar un paciente con lo minimo y completar despues.
-- Pero "incompleta" tiene que ser un estado explicito y visible, no un descuido
-- silencioso. Por eso: se relajan los NOT NULL, se agrega ficha_validada, y una
-- restriccion impide marcarla validada mientras falte algo.
-- =============================================================================
alter table public.pacientes alter column rut              drop not null;
alter table public.pacientes alter column fecha_nacimiento drop not null;
alter table public.pacientes alter column sexo             drop not null;
alter table public.pacientes alter column prevision        drop not null;
alter table public.pacientes alter column n_ficha          drop not null;
alter table public.pacientes alter column fecha_ingreso    set default current_date;

alter table public.pacientes add column if not exists ficha_validada boolean not null default false;
alter table public.pacientes add column if not exists riesgo_caida   text;
alter table public.pacientes add column if not exists etiquetas      text[] not null default '{}';
alter table public.pacientes add column if not exists es_prueba      boolean not null default false;
alter table public.pacientes add column if not exists origen         text;   -- 'sistema_a' | 'app_json' | 'fusion'

-- No se puede declarar validada una ficha a la que le falta lo obligatorio.
alter table public.pacientes drop constraint if exists pacientes_validada_completa;
alter table public.pacientes add constraint pacientes_validada_completa check (
  ficha_validada = false
  or (rut is not null and fecha_nacimiento is not null
      and sexo is not null and prevision is not null
      and n_ficha is not null and fecha_ingreso is not null)
);

-- Un mismo RUT no puede repetirse dentro del mismo tratante.
create unique index if not exists ux_pacientes_rut_por_kine
  on public.pacientes (kinesiologo_id, rut) where rut is not null and deleted_at is null;

-- Numero de ficha automatico cuando no se entrega.
create sequence if not exists public.seq_n_ficha;
create or replace function public.asigna_n_ficha()
returns trigger language plpgsql as $$
begin
  if new.n_ficha is null then
    new.n_ficha := lpad(nextval('public.seq_n_ficha')::text, 5, '0');
  end if;
  return new;
end $$;
drop trigger if exists trg_pac_n_ficha on public.pacientes;
create trigger trg_pac_n_ficha before insert on public.pacientes
  for each row execute function public.asigna_n_ficha();

-- Lo que le falta a cada ficha, para que la app lo muestre en pantalla.
create or replace view public.v_fichas_incompletas as
select p.id, p.kinesiologo_id, p.nombres, p.apellidos, p.ficha_validada,
       array_remove(array[
         case when p.rut              is null then 'rut'              end,
         case when p.fecha_nacimiento is null then 'fecha_nacimiento' end,
         case when p.sexo             is null then 'sexo'             end,
         case when p.prevision        is null then 'prevision'        end,
         case when p.n_ficha          is null then 'n_ficha'          end,
         case when p.telefono         is null then 'telefono'         end
       ], null) as campos_faltantes
from public.pacientes p
where p.deleted_at is null;


-- =============================================================================
-- SECCION 2 · sesiones: inasistencia medible
-- -----------------------------------------------------------------------------
-- Decision 3. El enum de estado ya distingue no_asistio y anulada; faltaba
-- poder explicar por que, y quien aviso.
-- =============================================================================
alter table public.sesiones add column if not exists motivo_inasistencia motivo_inasistencia_enum;
alter table public.sesiones add column if not exists aviso_previo boolean;
alter table public.sesiones add column if not exists evolucion_generada text;

alter table public.sesiones drop constraint if exists sesiones_motivo_solo_si_falta;
alter table public.sesiones add constraint sesiones_motivo_solo_si_falta check (
  motivo_inasistencia is null or estado in ('no_asistio','anulada')
);

-- Adherencia por paciente, que es la cifra que perseguias desde el principio.
create or replace view public.v_adherencia as
select paciente_id,
       count(*) filter (where estado = 'realizada')   as realizadas,
       count(*) filter (where estado = 'no_asistio')  as inasistencias,
       count(*) filter (where estado = 'anulada')     as anuladas,
       count(*) filter (where estado = 'agendada')    as agendadas,
       round(100.0 * count(*) filter (where estado = 'realizada')
             / nullif(count(*) filter (where estado in ('realizada','no_asistio')), 0), 1) as pct_asistencia
from public.sesiones where deleted_at is null
group by paciente_id;


-- =============================================================================
-- SECCION 3 · anamnesis estructurada + texto libre
-- -----------------------------------------------------------------------------
-- Decision 4: se conservan los 10 campos estructurados y se agrega el texto
-- libre al lado, mas el borrador que produzcan las automatizaciones. El texto
-- generado se guarda aparte del escrito por el profesional, a proposito:
-- una nota clinica y un borrador de maquina no son la misma cosa.
-- =============================================================================
alter table public.anamnesis add column if not exists texto_libre        text;
alter table public.anamnesis add column if not exists borrador_asistido  text;
alter table public.anamnesis add column if not exists revisada_por_profesional boolean not null default false;

alter table public.evaluaciones add column if not exists texto_libre       text;
alter table public.evaluaciones add column if not exists borrador_asistido text;
alter table public.evaluaciones add column if not exists revisada_por_profesional boolean not null default false;


-- =============================================================================
-- SECCION 4 · tablas nuevas para las automatizaciones del Sistema B
-- -----------------------------------------------------------------------------
-- Cada estructura de la app queda en su propia tabla, no dentro de un JSON.
-- =============================================================================

-- Biblioteca de ejercicios, por tratante.
create table if not exists public.ejercicios (
  id             uuid primary key default gen_random_uuid(),
  kinesiologo_id uuid not null references public.kinesiologos(id) on delete cascade,
  codigo         text,
  nombre         text not null,
  categoria      text,
  descripcion    text,
  dosis_sugerida text,
  contraindicaciones text,
  activo         boolean not null default true,
  datos          jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Plan de sesion: que ejercicios se propusieron y cuales aprobo el profesional.
create table if not exists public.planes_sesion (
  id             uuid primary key default gen_random_uuid(),
  paciente_id    uuid not null references public.pacientes(id) on delete cascade,
  kinesiologo_id uuid not null references public.kinesiologos(id) on delete cascade,
  numero         int,
  origen         text not null default 'manual',   -- 'manual' | 'propuesta_automatica'
  aprobado_por   uuid references public.kinesiologos(id),
  aprobado_en    timestamptz,
  datos          jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Ejercicio ejecutado dentro de una sesion: repeticiones, tolerancia, sintomas.
create table if not exists public.ejercicios_sesion (
  id            uuid primary key default gen_random_uuid(),
  sesion_id     uuid not null references public.sesiones(id) on delete cascade,
  ejercicio_id  uuid references public.ejercicios(id),
  orden         int,
  nombre        text not null,
  dosis         text,
  reps_objetivo int,
  reps_realizadas int,
  completado    boolean not null default false,
  tolerancia    text,
  dolor         smallint,
  sintomas      jsonb not null default '{}'::jsonb,
  observaciones text,
  created_at    timestamptz not null default now()
);

-- Evaluacion integral (la bateria de pruebas de la app).
create table if not exists public.evaluaciones_integrales (
  id             uuid primary key default gen_random_uuid(),
  paciente_id    uuid not null references public.pacientes(id) on delete cascade,
  kinesiologo_id uuid not null references public.kinesiologos(id) on delete cascade,
  version        text,
  finalizada     boolean not null default false,
  datos          jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Trazas del motor clinico: por que propuso lo que propuso.
create table if not exists public.motor_clinico (
  id             uuid primary key default gen_random_uuid(),
  paciente_id    uuid not null references public.pacientes(id) on delete cascade,
  kinesiologo_id uuid not null references public.kinesiologos(id) on delete cascade,
  tipo           text not null,   -- 'analisis' | 'resumen' | 'integracion' | 'irf'
  version_motor  text,
  datos          jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

create index if not exists ix_ejercicios_kine     on public.ejercicios (kinesiologo_id) where activo;
create index if not exists ix_planes_paciente     on public.planes_sesion (paciente_id);
create index if not exists ix_ejsesion_sesion     on public.ejercicios_sesion (sesion_id);
create index if not exists ix_evalint_paciente    on public.evaluaciones_integrales (paciente_id);
create index if not exists ix_motor_paciente      on public.motor_clinico (paciente_id, tipo);


-- =============================================================================
-- SECCION 5 · sellado de updated_at del lado servidor
-- -----------------------------------------------------------------------------
-- El testigo de version NO lo pone el navegador. Ya corregimos esto una vez.
-- =============================================================================
create or replace function public.sella_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := clock_timestamp(); return new; end $$;

do $$
declare t text;
begin
  foreach t in array array['pacientes','sesiones','anamnesis','evaluaciones','objetivos',
                           'alertas_clinicas','ejercicios','planes_sesion','evaluaciones_integrales'] loop
    execute format('drop trigger if exists trg_%I_sella on public.%I', t, t);
    execute format('create trigger trg_%I_sella before insert or update on public.%I
                    for each row execute function public.sella_updated_at()', t, t);
  end loop;
end $$;


-- =============================================================================
-- SECCION 6 · RLS en las tablas nuevas, con el mismo patron del esquema
-- -----------------------------------------------------------------------------
-- Alcance por paciente donde corresponde, por tratante donde el dato es suyo.
-- `force` ademas de `enable`: sin lo primero, el dueno de la tabla ignora
-- las politicas.
-- =============================================================================
do $$
declare t text;
begin
  foreach t in array array['ejercicios','planes_sesion','ejercicios_sesion',
                           'evaluaciones_integrales','motor_clinico'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force  row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update on public.%I to authenticated', t);
    execute format('revoke delete on public.%I from authenticated', t);
  end loop;
end $$;

drop policy if exists ejercicios_propio on public.ejercicios;
create policy ejercicios_propio on public.ejercicios for all to authenticated
  using      (kinesiologo_id = public.mi_kinesiologo_id())
  with check  (kinesiologo_id = public.mi_kinesiologo_id());

drop policy if exists planes_propio on public.planes_sesion;
create policy planes_propio on public.planes_sesion for all to authenticated
  using      (paciente_id in (select id from public.pacientes where kinesiologo_id = public.mi_kinesiologo_id()))
  with check  (paciente_id in (select id from public.pacientes where kinesiologo_id = public.mi_kinesiologo_id()));

drop policy if exists evalint_propio on public.evaluaciones_integrales;
create policy evalint_propio on public.evaluaciones_integrales for all to authenticated
  using      (paciente_id in (select id from public.pacientes where kinesiologo_id = public.mi_kinesiologo_id()))
  with check  (paciente_id in (select id from public.pacientes where kinesiologo_id = public.mi_kinesiologo_id()));

drop policy if exists motor_propio on public.motor_clinico;
create policy motor_propio on public.motor_clinico for all to authenticated
  using      (paciente_id in (select id from public.pacientes where kinesiologo_id = public.mi_kinesiologo_id()))
  with check  (paciente_id in (select id from public.pacientes where kinesiologo_id = public.mi_kinesiologo_id()));

-- El ejercicio de una sesion se alcanza a traves de la sesion y su paciente.
drop policy if exists ejsesion_propio on public.ejercicios_sesion;
create policy ejsesion_propio on public.ejercicios_sesion for all to authenticated
  using (sesion_id in (
    select s.id from public.sesiones s join public.pacientes p on p.id = s.paciente_id
    where p.kinesiologo_id = public.mi_kinesiologo_id()))
  with check (sesion_id in (
    select s.id from public.sesiones s join public.pacientes p on p.id = s.paciente_id
    where p.kinesiologo_id = public.mi_kinesiologo_id()));

-- Las vistas heredan la RLS de sus tablas, pero hay que dejarlas alcanzables.
revoke all on public.v_fichas_incompletas from anon;
revoke all on public.v_adherencia        from anon;
grant select on public.v_fichas_incompletas to authenticated;
grant select on public.v_adherencia        to authenticated;


-- =============================================================================
-- VERIFICACION · ejecutar y LEER los resultados
-- =============================================================================

-- 1 · las cinco tablas nuevas con RLS activa y forzada  (esperado: 5 filas, t/t)
select relname, relrowsecurity, relforcerowsecurity from pg_class
 where relname in ('ejercicios','planes_sesion','ejercicios_sesion',
                   'evaluaciones_integrales','motor_clinico');

-- 2 · anon sin privilegios en las tablas nuevas  (esperado: 0 filas)
select table_name, privilege_type from information_schema.role_table_grants
 where grantee='anon' and table_schema='public'
   and table_name in ('ejercicios','planes_sesion','ejercicios_sesion',
                      'evaluaciones_integrales','motor_clinico',
                      'v_fichas_incompletas','v_adherencia');

-- 3 · ninguna politica nueva de UPDATE/ALL sin with_check  (esperado: 0 filas)
select tablename, policyname from pg_policies
 where schemaname='public' and cmd in ('UPDATE','ALL') and with_check is null
   and tablename in ('ejercicios','planes_sesion','ejercicios_sesion',
                     'evaluaciones_integrales','motor_clinico');

-- 4 · que le falta a cada ficha existente
select nombres, apellidos, ficha_validada, campos_faltantes
from public.v_fichas_incompletas order by array_length(campos_faltantes,1) desc nulls last;

-- 5 · adherencia actual por paciente
select * from public.v_adherencia;
