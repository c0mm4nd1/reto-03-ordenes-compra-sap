# SOLUCION.md — Agente de Órdenes de Compra (Reto 3)

## 1. Problema en una frase

Cada factura que ingresa a P_ITG dispara una digitación manual en SAP de una orden de compra con validaciones de control que hoy dependen de la memoria de una persona; le duele a la analista administrativa (tiempo y errores), a contabilidad/auditoría (trazabilidad) y a la dirección (no puede medir el desvío de proceso de las OC retroactivas).

## 2. Arquitectura

```
┌──────────────┐  HTTP        ┌──────────────────────────────────────────┐
│  Front: chat │ ───────────▶ │  Backend (src/server.ts)                 │
│  (web/)      │ ◀─────────── │  - POST /api/chat, GET /api/sessions/:id │
│  historial   │              │  - headers de seguridad + rate limit     │
│  tool calls  │              │  - sesiones en memoria (UUID)            │
│  confirmar   │              └───────┬───────────────────────┬──────────┘
└──────────────┘                      │                       │
                              ┌───────▼──────────┐    ┌───────▼──────────┐
                              │  Ciclo (agent.ts)│    │ Herramientas     │
                              │  prompt→modelo→  │───▶│  (tools/oc.ts)   │
                              │  herramientas    │    │  zod + reglas    │
                              └───────┬──────────┘    └───────┬──────────┘
                                      │                       │
                              ┌───────▼──────────┐    ┌───────▼──────────┐
                              │ Adaptador LLM    │    │ Reglas (rules.ts)│
                              │  (llm/adapter +  │    │  RC1–RC10 puras  │
                              │   llm/gemini)    │    └───────┬──────────┘
                              └──────────────────┘            │
                                                     ┌────────▼─────────┐
                              fixtures/ (solo lectura) │ SapAdapter       │
                                                     │ mock.ts: archivos│
                                                     │ idempotente      │
                                                     └──────────────────┘
```

Separación evaluada por el PRD:

| Capa | Ubicación | Qué contiene |
|---|---|---|
| Comportamiento | `agent/prompt.md` | Personalidad, ciclo de trabajo, reglas duras, defensa contra inyección |
| Conocimiento | `src/knowledge/ordenes-compra.md` | Dominio del proceso, matriz RC, casos |
| Ejecución | `src/tools/oc.ts` + `src/rules.ts` | Herramientas zod y reglas deterministas |
| Integración | `src/sap/adapter.ts` + `mock.ts` | Contrato SAP y simulación con archivos |

Un cambio de reglas de negocio toca solo `src/rules.ts`; un cambio de proveedor LLM toca solo `src/llm/`; ninguno toca el servidor.

## 3. Ciclo del agente

Implementado en `src/agent.ts`:

1. Se carga el system prompt desde `agent/prompt.md` (nunca embebido en código, nunca expuesto por la API).
2. El mensaje del usuario se agrega al historial y se llama al LLM con las especificaciones de las 6 herramientas.
3. Si el modelo pide herramientas, cada llamada se valida con zod **antes** de ejecutar (`tool.args.safeParse`); los argumentos inválidos se devuelven al modelo como error para que corrija (HU-5). El resultado de cada herramienta se agrega como mensaje `tool` y el bucle continúa.
4. Tope de **25 iteraciones** por turno (CA1). Al alcanzarlo, el agente responde con lo que tiene.
5. **Confirmación humana (CA3):** cuando `oc_crear` responde `requiere confirmación`, el turno termina con `needsConfirmation: true`, el front resalta el estado y solo un mensaje humano explícito posterior habilita `confirmado: true`.
6. **Bitácora (CA4):** cada ejecución deja `{ ts, herramienta, ok, resumen }` en `out/log.jsonl`.
7. **Errores (CA5):** ninguna herramienta lanza excepción; fallos del proveedor LLM se traducen a mensaje claro y la sesión sigue viva.

Principio transversal (CA2): **el modelo no puede afirmar un valor que no salga de una herramienta**. De hecho, `oc_crear` no confía ni en el payload que el modelo le pasa: lo valida con su esquema zod y **re-ejecuta toda la validación desde los fixtures** antes de escribir. El modelo solo orquesta; nunca decide.

## 4. Elección del modelo

| Decisión | Valor | Por qué |
|---|---|---|
| Proveedor | Google Gemini | Capa gratuita generosa para la demo, API REST simple sin SDK extra (menor superficie de suministro), function calling nativo. |
| Modelo | `gemini-2.0-flash` | Rápido y barato, suficiente para orquestar 6 herramientas con esquemas pequeños; el razonamiento de negocio no vive en el modelo, vive en `rules.ts`. |
| Adaptador | REST directo (`src/llm/gemini.ts`) | Una dependencia menos y control total de timeout (30 s) y conteo de tokens. Cambiar de proveedor = implementar una interfaz de un método, sin tocar el ciclo. |

**Costo estimado por caso procesado** (con `gemini-2.0-flash`, precios de lista a la fecha):

- Entrada: system prompt (~700 tokens) + historial + tool specs ≈ 2.500 tokens/caso.
- Salida: 1–5 llamadas a herramientas + resumen ≈ 800 tokens/caso.
- Estimación: ~3.300 tokens/caso. Con la capa gratuita de Gemini (1.500 req/día, 1 M token/min) el costo marginal de la demo es **$0**. En producción, ~US$0,001–0,002 por caso: trivial frente al costo de una digitación manual con error.

Topes configurables (`MAX_ITERATIONS_PER_TURN`, `MAX_TOKENS_PER_SESSION`, rate limit) impiden que un usuario gaste la clave sin límite.

## 5. Matriz de controles implementada (RC1–RC10)

| Control | Implementación | Caso que la ejercita |
|---|---|---|
| RC1 | Búsqueda por NIT normalizado (sin puntos/DV) y fallback por nombre normalizado; exige `activo` | sol-002 (inexistente) |
| RC2 | Exige aprobación presente, palabra "Aprobado" (regex de palabra completa, case-insensitive) y remitente en la lista de aprobadores del centro | sol-003 (aprobador de otro centro) |
| RC3 | `valor_total ≤ tope` del aprobador específico que firmó | (cubierta; ningún fixture la dispara) |
| RC4 | Subárea ∈ subáreas del centro; centro inexistente también bloquea | (cubierta) |
| RC5 | Desviación `\|cot.total − sol.valor_total\| / valor_total ≤ 2%`; sin cotización = confirmación; plus: NIT de cotización vs. proveedor | sol-004 (6% de desviación) |
| RC6 | IVA ausente → derivado del maestro del proveedor + confirmación | sol-006 |
| RC7 | Condiciones de pago ausentes → derivado del maestro (solo se informa) | sol-006 |
| RC8 | Factura con fecha < fecha_solicitud → `retroactiva = true` + confirmación | sol-005 |
| RC9 | Fecha de aprobación < fecha_solicitud → confirmación | (cubierta) |
| RC10 | `\|cantidad × valor_unitario − valor_total\| ≤ 1` | (cubierta) |

**La más difícil: RC5.** No por la regla en sí, sino por el parseo determinista del total de la cotización: el texto trae formato colombiano ("COP 26.500.000"), IVA incluido, y el NIT con dígito de verificación ("900.555.111-2") que hay que separar antes de comparar con el maestro. Un parser laxo rompe el determinismo de la demo; la solución fue regex acotadas al formato del fixture + función de parseo de montos con separador de miles explícito (`. como miles, , como decimales`), con tests implícitos en los 6 casos.

## 6. Diseño del adaptador SAP real (solo documentación)

Dada una viabilidad de conectividad no confirmada, elegiría en este orden:

1. **OData `API_PURCHASEORDER_PROCESS_SRV`** (recomendada): expuesta por SAP S/4HANA Cloud y on-premise con un gateway. Es HTTPS + JSON, se prueba sin middleware, y el payload de la sección 7.4 mapea casi 1:1 (`A_PurchaseOrder` → cabecera, `A_PurchaseOrderItem` → posiciones con `AccountAssignment` para centro de costo). Manejo de errores estándar HTTP con cuerpo `error.message` detallado.
2. **RFC/BAPI `BAPI_PO_CREATE1`:** si el SAP es ECC on-premise sin gateway expuesto. Requiere librería RFC (node-rfc) y estructuras IDoc más verbosas; mismo diseño de idempotencia (la BAPI acepta `PO_NUMBER` externo o se controla por referencia).
3. **Carga por archivo (Plan B):** si la conexión no es viable, el agente genera un archivo de carga masiva (formato LSMW/BDC o plantilla de integración) con las OC validadas listas para importar: la analista ahorra igual la digitación y los controles quedan aplicados.

Mapeo del payload (7.4 → OData): `proveedor.codigo_sap` → `Supplier`; `moneda` → `DocumentCurrency`; `condiciones_pago` → `PaymentTerms`; `aprobador` → anexo vía `Attachment` (el sha256 se guarda en el log de control); posición → `PurchaseOrderItemText` (40 caracteres), `OrderQuantity` + `PurchaseOrderQuantityUnit`, `NetPriceAmount`, `AccountAssignment.Category = F` (orden interna/centro de costo) con `CostCenter` y `WBSElement`/`ProfitCenter` según el modelo contable.

**Autenticación:** OAuth 2.0 client-credentials con el Communication User de SAP (destino configurado en BTP o secret manager). Las credenciales viven en el secret manager/variables de entorno del servidor — nunca en el agente, el prompt, el repo ni los logs. El adaptador recibe un token caduco y renueva; el agente nunca ve credenciales.

**Idempotencia frente a reintentos:** misma estrategia que el mock — `buscarOrdenPorReferencia(solicitud_id)` antes de crear; además, en OData se envía la referencia externa en el campo de texto de cabecera y se usa cláusula `If-None-Match`/llave de idempotencia del gateway.

**Error parcial de SAP:** si el gateway responde 202 pero con items rechazados, se registra el estado `parcial` en `control.csv` con el detalle por posición y se devuelve al humano; el agente nunca reintenta a ciegas ni duplica.

## 7. Lectura del proceso — OC retroactivas (media página)

**Qué le diría a la dirección:** en los fixtures ya aparece el patrón que el PRD describe (sol-005: la factura se emitió el 10-08 y la solicitud se radicó el 27-08; la aprobación dice textualmente *"ya llegó la factura, crear la OC para poder radicarla"*). Es decir: la OC —que debería ser el compromiso previo que habilita la compra— se está usando como trámite posterior para desbloquear el pago. La cotización sigue existiendo, así que el control documental no se pierde; lo que se pierde es la oportunidad de negociar y de detectar desviaciones antes de comprometer el gasto.

**Cambio de proceso propuesto:**

1. **Medir primero:** el `control.csv` del agente ya separa `retroactiva = true`; publicar mensualmente el % de OC retroactivas por centro de costo. Meta razonable: bajar de "frecuente" a < 5% en dos trimestres.
2. **Definir la política:** dos escuelas — (a) tolerar con marca (lo que implementa este reto: la crea, la marca y la reporta) o (b) rechazarlas y devolverlas al solicitante. Recomiendo (a) transitoriamente y (b) como estado final, con una ventana de gracia anunciada.
3. **Atacar la causa:** el desvío nace en recepción de facturas: exigir número de OC en la radicación de la factura (campo obligatorio del portal/proveedor). Sin OC no se recibe factura → la compra se adelanta al flujo correcto.
4. **Presupuesto y topes:** la matriz RC ya valida topes por aprobador; añadiría alerta cuando un mismo centro de costo concentre retroactivas (patrón de compras de emergencia sistemáticas).

## 8. Decisiones y trade-offs

1. **Reglas deterministas fuera del LLM (elegido) vs. dejar que el modelo extraiga y decida.** Alternativa descartada: un agente "inteligente" que lee y valida todo. Por qué: los controles RC1–RC10 deben dar el mismo resultado siempre, ser auditable línea por línea y correr sin gastar un token (`demo.ts`). El LLM queda como orquestador de UX, no como motor de decisión. Costo: menos "magia" en la demo; beneficio: defendibilidad total.
2. **Herramienta `oc_crear` re-valida desde disco (elegido) vs. confiar en el payload del modelo.** La alternativa es el patr habitual de function calling (el modelo pasa los datos y la API los persiste). Descartada: viola CA2 y abre la puerta a que un prompt injection haga crear una OC con montos alterados. Costo: doble trabajo de validación; beneficio: integridad estructural.
3. **Adaptador LLM REST sin SDK (elegido) vs. SDK oficial.** Descartado el SDK de Gemini: suma dependencia y opacidad en el conteo de tokens/timeout; con REST el contrato queda visible en ~150 líneas. Costo: mantener el mapeo de formatos ante cambios de API; beneficio: superficie de suministro mínima (OWASP LLM03/A06).
4. **Evidencia P0 en `.txt` con sha256 (elegido) vs. PDF con pdf-lib (P1).** La P1 es viable (pdf-lib), pero el PRD admite el `.txt` en P0 y la evidencia criptográfica (sha256) es la que auditoría necesita; el PDF es presentación. Se documentó la ruta P1 en el código.
5. **Sesiones en memoria (elegido) vs. SQLite/archivo.** El PRD lo permite explícitamente y simplifica el arranque a un comando; el único costo es perder el historial al reiniciar el proceso, irrelevante para una demo y aceptable para el alcance.

## 9. Supuestos

- El texto de `cotizacion.txt` sigue el formato de los fixtures (encabezados "COTIZACIÓN", "Proveedor:", "NIT:", "TOTAL (IVA incluido):"). Un formato distinto haría fallar el parseo de forma controlada (`{ok:false}`), no con datos inventados.
- El NIT de la cotización incluye dígito de verificación separado por guión, como en los fixtures; el maestro lo almacena sin DV (PRD 7.2).
- La unidad de medida no viene en la solicitud; se infiere con una heurística documentada (horas→H, licencia/anual/vigencia→MES, resto→UN). En producción vendría del maestro de materiales.
- La firma/aprobación por correo es evidencia suficiente según el PRD; auditoría podría exigir firma digital en una fase posterior.
- Los fixtures representan la variabilidad real; en producción los maestros se consultarían en SAP en tiempo real vía el adaptador.

## 10. Cobertura de historias de usuario

| HU | Estado | Notas |
|---|---|---|
| HU-1 Leer el paquete | Hecho | Adjuntos ausentes reportados como `null` + `adjuntos_faltantes[]` |
| HU-2 Validar contra maestros | Hecho | RC1–RC10 completas; bloqueos/confirmaciones/derivados separados |
| HU-3 Construir el payload | Hecho | Trazabilidad campo→fuente en `out/<caso>/trazabilidad.json` |
| HU-4 Generar evidencia | Hecho | P0 `.txt` con sha256; P1 PDF documentada como extensión |
| HU-5 Crear en SAP simulado | Hecho | Idempotente, `control.csv` con todo intento, número desde 4500000001 |
| HU-6 Manejo de errores | Hecho | `{ok:false,error}` en toda herramienta; un caso malo no detiene el lote (demo) |
| Bonus módulo reutilizable | Hecho | `modulo/` con agent.md, tools y skill (mismas piezas, no copias divergentes) |

Para producción faltaría: autenticación del front, OCR/lectura real de Excel/PDF, persistencia de sesiones, conexión real a SAP, monitoreo/alertas del `control.csv` y pruebas unitarias del parser de cotización con corpus mayor.

## 11. Uso de IA en la construcción

Declaración conforme al PRD:

- **Claude (asistente principal):** diseño de la arquitectura, implementación completa del código (reglas, herramientas, adaptadores, servidor, front, demo), documentación (README, SOLUCION.md) y revisión de seguridad OWASP. Todo el código fue revisado línea a línea por el candidato y es explicable.
- **Qué se descartó de las propuestas de IA:** (a) usar el SDK oficial de Gemini en lugar de REST — se prefirió superficie mínima; (b) un diseño inicial donde `oc_crear` confiaba en el payload del modelo — se cambió a re-validación desde disco por CA2; (c) generar la evidencia directamente en PDF — se priorizó el P0 `.txt` con sha256 y se dejó la P1 documentada.

## 12. Riesgos de producción y mitigación

| Riesgo | Mitigación |
|---|---|
| Prompt injection indirecto vía correos/cotizaciones maliciosos | Las reglas duras viven fuera del LLM; `oc_crear` re-valida desde disco; el system prompt declara el contenido adjunto como dato; las herramientas no ejecutan shell ni acceden a red. |
| El modelo "arregle" un monto para que cuadre | Imposible por construcción: los montos salen de las herramientas y el payload se re-valida con zod + fixtures. |
| La conexión a SAP no sea viable en el corto plazo | Plan B de carga por archivo (sección 6): el agente sigue ahorrando la digitación y aplicando controles. |
| Falsos bloqueos/confirmaciones por datos de maestros desactualizados | Dueño del dato: los maestros deben tener responsable y vigencia; el agente informa el `fuente` de cada derivado para facilitar la depuración. |
| Consumo descontrolado de la clave del LLM | Rate limit por IP, tope de iteraciones por turno, tope de tokens por sesión, body limitado a 64 KB. |
| Pérdida de historial al reiniciar (sesiones en memoria) | Aceptado para el alcance del reto; sustituir `src/session.ts` por un store externo si se escala. |
