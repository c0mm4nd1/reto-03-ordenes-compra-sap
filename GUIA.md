# Guía del proyecto — Agente de Órdenes de Compra (Reto 3)

Documento práctico: qué es el proyecto, cómo está construido, cómo se consume el servicio y cómo probarlo paso a paso (en local y en la URL pública). Para el diseño profundo (decisiones, trade-offs, costos, diseño SAP real) ver [`SOLUCION.md`](./SOLUCION.md).

---

## 1. Qué es

Un **agente conversacional** que automatiza la creación de órdenes de compra (OC) en un SAP simulado. La analista escribe en un chat ("procesa la solicitud sol-004") y el agente:

1. Lee el paquete del caso (correo, solicitud, cotización, aprobación, factura si existe).
2. Aplica la **matriz de controles RC1–RC10** (bloqueos, confirmaciones, derivados).
3. Construye el payload de la OC con **trazabilidad campo → fuente**.
4. Genera la **evidencia de aprobación** con sha256.
5. Crea la OC en el SAP simulado de forma **idempotente**, dejando auditoría en `control.csv`.

Lo determinista (reglas, parseos, validaciones, escrituras) **no depende del modelo de lenguaje**: corre igual sin gastar un token. El LLM solo orquesta la conversación.

## 2. Arquitectura en una imagen

```
Chat (web/) → POST /api/chat → ciclo del agente (src/agent.ts)
    → adaptador LLM (src/llm/gemini.ts) decide qué herramienta llamar
    → herramientas zod (src/tools/oc.ts) ejecutan reglas (src/rules.ts)
    → SapAdapter mock (src/sap/mock.ts) persiste en out/
```

Separación clave: **comportamiento** en `agent/prompt.md`, **conocimiento** en `src/knowledge/`, **ejecución** en `src/tools/`. Cambiar una regla de negocio no toca el servidor; cambiar de proveedor LLM no toca el ciclo.

## 3. Cómo levantarlo en local

Requisitos: Node 20+ o Bun. Clave de Gemini solo necesaria para el chat con modelo (la demo no la usa).

```bash
git clone https://github.com/c0mm4nd1/reto-03-ordenes-compra-sap.git
cd reto-03-ordenes-compra-sap
cp .env.example .env          # opcional: poner GEMINI_API_KEY para el chat
bun install                   # o npm install
bun run dev                   # http://localhost:3000
```

## 4. Cómo probarlo

### 4.1 Verificación sin modelo (siempre funciona, determinista)

```bash
bun run demo.ts
```

Procesa los 6 casos llamando a las herramientas directamente. Resultado esperado:

| Caso | Escenario | Resultado |
|---|---|---|
| sol-001 | Flujo feliz | OC 4500000001 sin intervención humana |
| sol-001 (2ª pasada) | Idempotencia | Devuelve la MISMA OC (no duplica) |
| sol-002 | Proveedor inexistente | **Bloqueo RC1** con acción sugerida |
| sol-003 | Aprobador de otro centro | **Bloqueo RC2** con acción sugerida |
| sol-004 | Cotización desviada 6% | **Confirmación RC5**, luego OC con `confirmado=true` |
| sol-005 | Factura previa a solicitud | **Confirmación RC8**, OC marcada `retroactiva=true` |
| sol-006 | IVA/condiciones ausentes | **Derivados RC6/RC7** + confirmación, luego OC |

Artefactos en `out/`: `control.csv` (auditoría de todo intento), `sap/ordenes.jsonl`, `log.jsonl`, y por caso `aprobacion.txt` (con sha256) y `trazabilidad.json`.

### 4.2 Chat con el modelo (URL pública)

Abre https://reto-03-ordenes-compra-sap.vercel.app y prueba estos mensajes (sesión nueva cada uno):

| # | Mensaje | Qué demuestra |
|---|---|---|
| 1 | `Procesa la solicitud sol-001` | Flujo feliz: 5 llamadas a herramientas visibles y número de OC |
| 2 | `Procesa la solicitud sol-002` | Bloqueo RC1 explicado con la acción sugerida |
| 3 | `Procesa la solicitud sol-004 y no la crees hasta que yo confirme` | La tabla de la OC, la confirmación RC5 resaltada en naranja; responde `confirmo` y se crea |
| 4 | `Procesa la solicitud sol-005` | Detección de OC retroactiva (medición del desvío) |
| 5 | `Procesa sol-001 otra vez` | Idempotencia: devuelve la OC existente |

El front muestra cada tool call (nombre, argumentos, resultado) y **resalta el estado de confirmación humana** antes de cualquier acción con excepciones.

### 4.3 Consumo directo de la API (curl)

Crear sesión y procesar un caso:

```bash
URL="https://reto-03-ordenes-compra-sap.vercel.app"

# Salud del servicio (sin exponer claves)
curl -s $URL/api/health
# → {"ok":true,"provider":"gemini","model":"...","llmConfigured":true}

# Primer mensaje (crea sesión)
curl -s -X POST $URL/api/chat -H 'Content-Type: application/json' \
  -d '{"message":"Procesa la solicitud sol-002"}'
# → {"sessionId":"...","reply":"...","toolCalls":[...],"needsConfirmation":false}

# Continuar la misma sesión (p. ej. confirmar una excepción)
curl -s -X POST $URL/api/chat -H 'Content-Type: application/json' \
  -d '{"sessionId":"<id-devuelto>","message":"confirmo, crea la OC"}'

# Recuperar el historial de una sesión
curl -s $URL/api/sessions/<id-devuelto>
```

Respuesta de `/api/chat`:

| Campo | Significado |
|---|---|
| `sessionId` | UUID de la sesión (reutilizar para mantener contexto) |
| `reply` | Texto del agente |
| `toolCalls[]` | Herramientas ejecutadas: `name`, `args`, `ok`, `result` |
| `needsConfirmation` | `true` cuando el agente espera confirmación humana (CA3) |

## 5. Las 6 herramientas del agente

| Herramienta | Para qué la llama el modelo |
|---|---|
| `oc_leer_paquete` | Leer y normalizar el paquete documental de un caso |
| `oc_validar` | Aplicar RC1–RC10 y obtener bloqueos/confirmaciones/derivados |
| `oc_construir_payload` | Ver la OC exactamente como quedaría en SAP (+ trazabilidad) |
| `oc_generar_evidencia` | Crear el anexo de aprobación con sha256 |
| `oc_crear` | Crear la OC (idempotente; exige `confirmado=true` si hay excepciones) |
| `oc_leer_excel` | P1 opcional (los fixtures llegan normalizados a JSON) |

## 6. Matriz de controles resumida

| Regla | Control | Efecto |
|---|---|---|
| RC1 | Proveedor existe y activo | Bloqueo |
| RC2 | Aprobación válida del aprobador del centro | Bloqueo |
| RC3 | Valor ≤ tope del aprobador | Bloqueo |
| RC4 | Subárea pertenece al centro | Bloqueo |
| RC5 | Cotización presente y ≤ 2% de desviación | Confirmación |
| RC6 | IVA ausente → derivado del maestro | Confirmación + derivado |
| RC7 | Condiciones de pago ausentes → derivado | Informado |
| RC8 | Factura anterior a solicitud → retroactiva | Confirmación + marca |
| RC9 | Aprobación anterior a solicitud | Confirmación |
| RC10 | cantidad × valor unitario ≈ valor total | Bloqueo |

## 7. Seguridad aplicada (resumen)

- **OWASP Web:** validación zod de entradas, anti path traversal (`safeJoin`), headers de seguridad (CSP, X-Frame-Options, nosniff), rate limit por IP (429), body limitado a 64 KB, sesiones UUID no enumerables, sin trazas crudas al cliente.
- **OWASP LLM:** las herramientas son la única fuente de valores (el modelo no puede afirmar datos que no salgan de ellas); argumentos de herramientas validados con zod; `oc_crear` re-valida desde los fixtures sin confiar en el modelo; confirmación humana antes de acciones con excepciones (agencia limitada); defensa contra prompt injection indirecto declarada en el system prompt; el system prompt nunca se expone por la API; topes de iteraciones/tokens por sesión; la clave del LLM jamás sale del entorno del backend.
- **Datos:** los fixtures son ficticios y de solo lectura; `.env`, `out/` y `node_modules/` nunca se versionan.

## 8. Estructura del repositorio

```
agent/prompt.md          system prompt (comportamiento)
src/rules.ts             matriz RC1–RC10 y construcción del payload
src/tools/oc.ts          herramientas zod del agente
src/agent.ts             ciclo del agente
src/llm/                 adaptador LLM (interfaz + Gemini REST)
src/sap/                 contrato SapAdapter + mock idempotente
src/server.ts            API HTTP + front estático + seguridad
src/session.ts           sesiones en memoria
src/knowledge/           conocimiento del dominio
web/                     front de chat
demo.ts                  verificación determinista sin modelo
modulo/                  bonus: agente empaquetado como módulo reutilizable
fixtures/                datos del reto (solo lectura)
README.md                arranque, API y estructura
SOLUCION.md              diseño, decisiones, costos, SAP real, riesgos
GUIA.md                  este documento
```

## 9. Limitaciones conocidas

- Sesiones en memoria: se pierden al reiniciar el proceso (aceptado por el PRD).
- Cuota del LLM: la clave gratuita de Gemini tiene límites diarios por modelo; si se agotan, el chat responde con el error del proveedor y la demo sigue funcionando igual (no usa LLM).
- `oc_leer_excel` es P1 opcional: los fixtures ya llegan normalizados a JSON.
- En Vercel (serverless) las escrituras van a `/tmp/out` (ephemeral): los artefactos se generan por invocación y no persisten entre llamadas; en local sí persisten en `out/`.
