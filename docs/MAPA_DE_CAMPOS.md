# Mapa de campos · interfaz del Sistema B sobre el modelo del Sistema A

Emitido el 27-08-2026. Base: esquema real de `recupera` y campos reales
extraídos de `RECUPERA_v5_4_3.html`, no de memoria.

---

## Resumen en una línea

El esquema clínico es **mucho más rico** que la app, y la app tiene estructuras
que el esquema **no puede alojar**. El trabajo no es "conectar": es decidir, campo
por campo, qué se rescata, qué se agrega y qué se descarta.

---

## Parte 1 · Lo que el esquema tiene y la app no sabe mostrar

Si conectamos la app tal cual, estos datos **quedan invisibles** — siguen en la
base, pero el kinesiólogo deja de verlos y de poder actualizarlos.

### Identificación del paciente

| Campo del esquema | ¿La app lo tiene? |
|---|---|
| `n_ficha` (NOT NULL) | no |
| `rut` (NOT NULL) | no |
| `nombres` / `apellidos` separados | sólo un campo `name` |
| `fecha_nacimiento` (NOT NULL) | sólo `age`, un número |
| `sexo` (NOT NULL, enum) | no |
| `genero` | no |
| `prevision` (NOT NULL, enum) | no |
| `ocupacion` | no |
| dirección: calle, número, depto, comuna, región | no |
| `email`, `telefono` | sí (en el formulario) |
| `fecha_ingreso` (NOT NULL) | no |
| `activo` / `deleted_at` | sólo `archived` |

### Tablas completas que la app ignora

`contactos_emergencia` · `anamnesis` (10 campos clínicos) · `evaluaciones`
(diagnóstico médico de referencia, diagnóstico kinésico, inspección y palpación,
ROM y fuerza, pruebas especiales, EVA inicial) · `objetivos` (métrica, valor
basal, valor meta, unidad, plazo en semanas, estado) · `mediciones` (tipadas,
numéricas, con unidad y fecha) · `antecedentes_medicos` · `alergias` (con
severidad) · `medicamentos` (dosis, frecuencia, vía, motivo, vigencia) ·
`consentimientos` · `documentos` · `alertas_clinicas` · `adendas_sesion`

### En sesiones

| Campo | ¿La app lo tiene? |
|---|---|
| `estado`: agendada / realizada / **no_asistio** / anulada | **no** |
| `modalidad`: domicilio / box / telerehabilitación | no |
| `proxima_sesion` | no |
| `procedimientos`, `notas_clinicas`, `respuesta_paciente` | parcialmente |

---

## Parte 2 · Tres cosas que hay que mirar de frente

### El consentimiento de la app no sirve legalmente

La app tiene **una casilla booleana**. El esquema tiene una tabla con cuatro
tipos: `tratamiento`, `tratamiento_datos`, `registro_imagen`,
`telerehabilitacion`.

`tratamiento_datos` es justamente el consentimiento que exigen la Ley 19.628 y
la 21.719, y es **distinto** del consentimiento para tratar al paciente. Una sola
casilla no puede representar los dos, y no deja constancia de cuándo se otorgó ni
sobre qué.

**Aquí el esquema tiene razón y la app está mal.** No es un campo que falte: es
un requisito legal que la interfaz no cumple.

### La app no registra inasistencias

`estado_sesion_enum` incluye `no_asistio`. La app no tiene ese concepto: una
sesión existe o no existe.

Tú me dijiste el primer día que el objetivo era reducir el ausentismo. **Tu
propio esquema lo mide y la interfaz que quieres conservar no.** Si conectamos
sin agregarlo, sigues sin poder contar cuántas sesiones se perdieron.

### Migrar de la app al esquema exige datos que la app nunca pidió

En `pacientes` son obligatorios: `n_ficha`, `rut`, `fecha_nacimiento`, `sexo`,
`prevision`, `fecha_ingreso`.

La app **nunca capturó ninguno** — guarda `age`, un número, del que no se puede
deducir una fecha de nacimiento.

Consecuencia concreta: **Nathaly no se puede migrar automáticamente.** Vas a
tener que completar a mano su RUT, fecha de nacimiento, sexo y previsión. Lo
mismo con cualquier paciente que sólo exista en el JSON.

---

## Parte 3 · Lo que la app tiene y el esquema no puede guardar

Estas son tus automatizaciones. Si no les damos dónde vivir, dejan de funcionar.

| Estructura de la app | Para qué sirve | Dónde iría |
|---|---|---|
| `integralAssessment` + backups | evaluación integral, batería de pruebas | tabla nueva `evaluaciones_integrales` |
| `exerciseLibrary` | biblioteca de ejercicios | tabla nueva `ejercicios` |
| `plans`, `sessionProposals` | constructor y propuestas | tabla nueva `planes_sesion` |
| `tolerance` / `symptoms` / `reps` por ejercicio | sesión guiada | tabla nueva `ejercicios_sesion` |
| `irfHistory` | índice de recuperación funcional | `mediciones` con tipo nuevo |
| `autoEvolution` | evolución generada | `sesiones.notas_clinicas` |
| `integrationHistory`, `diagnosticAnalysis`, `evaluationSummary` | trazas del motor | tabla nueva `motor_clinico` |
| `fallRisk`, `tags` | riesgo de caída, etiquetas | columnas nuevas en `pacientes` |
| `consentHistory` | historial de consentimiento | ya existe: `consentimientos` |

**Cinco tablas nuevas y algunas columnas.** Es trabajo acotado y no rompe el
diseño clínico: cada cosa sigue en su lugar.

### Un enum que se queda corto

`tipo_metrica_enum` permite `eva | rom | fuerza | perimetria | funcional |
antropometria | otra`. La app registra además **Borg, SpO₂, frecuencia cardíaca
y presión arterial**. Meterlos todos como `otra` los vuelve imposibles de
graficar por separado. Hay que extender el enum con `borg`, `spo2`, `fc`, `pa`.

---

## Parte 4 · Decisiones que son tuyas, no mías

Ninguna de estas la puedo tomar yo.

1. **Los campos obligatorios de `pacientes`.** ¿Los pides en el formulario de la
   app —más tiempo por paciente, mejor ficha— o los haces opcionales en el
   esquema? Recuerda que RUT y previsión son lo que permite emitir documentos y
   facturar.

2. **El consentimiento.** ¿La app pasa a mostrar los cuatro tipos por separado,
   o registramos sólo `tratamiento` y `tratamiento_datos` y dejamos los otros
   dos para cuando hagas telerehabilitación o registro de imagen?

3. **Inasistencias.** ¿Agregamos «no asistió» a la pantalla de sesiones? Es
   barato y es lo que te permite medir el ausentismo.

4. **Anamnesis y evaluación inicial.** El esquema tiene 10 campos estructurados;
   la app tiene texto libre. ¿Cambiamos la pantalla o guardamos el texto libre
   en `motivo_consulta` y perdemos la estructura?

5. **Gesiva está en los dos sistemas.** Hay que decidir cuál versión gana, o
   fusionarlas revisando ambas a mano. Es una sola paciente: hazlo mirando.

---

## Lo que queda abierto

- El tipo `email` aparece como `USER-DEFINED` pero no es un dominio de `public`.
  Una consulta pendiente para saber qué valida:
  `select n.nspname, t.typname from pg_type t join pg_namespace n on n.oid=t.typnamespace where t.typname='email';`
- El informe de exposición: `with_check` de las políticas de INSERT y si
  `mi_kinesiologo_id` es `security definer` con `search_path` fijo.

---

## Siguiente paso

Contesta las cinco decisiones de la Parte 4. Con eso escribo el SQL de extensión
del esquema y recién entonces se toca la app.
