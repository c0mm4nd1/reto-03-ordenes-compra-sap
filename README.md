# Agente conversacional — Órdenes de Compra SAP (Reto 3)

Agente conversacional en TypeScript que automatiza la lectura, validación de controles y creación de órdenes de compra en un SAP simulado. Construido como reto técnico del proceso de selección (equipo de agentes de IA). **Toda la lógica de negocio es determinista y verificable sin consumir tokens de ningún modelo.**

## Demo en vivo

**URL pública:** https://reto-03-ordenes-compra-sap.vercel.app

Enlace para probar durante la defensa técnica: chat funcional con el agente, con visualización de llamadas a herramientas y confirmaciones humanas.

## Levantar en local (un comando)

Requisitos: Node 20+ o Bun. Dependencias: `zod` y `tsx` únicamente.

```bash
cp .env.example .env        # completar GEMINI_API_KEY para el chat con el modelo
bun install                 # o: npm install
bun run dev                 # front + backend en http://localhost:3000
```

Sin clave de LLM, el servidor igualmente sirve el front y responde por la API con un error claro; la verificación sin modelo (`demo.ts`) funciona siempre.

## Verificación sin modelo (determinismo)

```bash
bun run demo.ts
```

Procesa los 6 casos de `fixtures/reto-03/solicitudes/` llamando directamente a las herramientas (sin LLM): muestra `apta`, bloqueos, confirmaciones, `retroactiva` y número de OC por caso. Ejecuta `sol-001` dos veces para evidenciar idempotencia y una confirmación explícita para `sol-004`. `out/` se limpia al inicio: dos ejecuciones consecutivas producen el mismo resultado (salvo timestamps).

## Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `GEMINI_API_KEY` | Solo para el chat con modelo | Clave del proveedor LLM. **Solo existe en el entorno del backend**: nunca en el repo, el front, los logs ni las respuestas de la API. |
| `GEMINI_MODEL` | No | Por defecto `gemini-flash-latest`. |
| `MAX_ITERATIONS_PER_TURN` | No | Tope de iteraciones herramienta→modelo por turno (25). |
| `MAX_TOKENS_PER_SESSION` | No | Tope acumulado de tokens por sesión (20000). |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX_REQUESTS` | No | Rate limit de `/api/chat` (60 s / 12 req por IP). |
| `PORT` | No | Por defecto 3000. |

## API

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId?, message }` → `{ sessionId, reply, toolCalls[], needsConfirmation }`. Sin `sessionId` crea una sesión nueva. |
| `GET` | `/api/sessions/:id` | Historial completo de la sesión (nunca incluye el system prompt). |
| `GET` | `/api/health` | `{ ok, provider, model, llmConfigured }` — diagnóstico sin exponer claves. |

## Estructura

```
├── agent/prompt.md            # system prompt (comportamiento; no va embebido en código)
├── src/
│   ├── server.ts              # API HTTP, headers de seguridad, rate limit, front estático
│   ├── agent.ts               # ciclo del agente (tope de iteraciones, confirmación humana)
│   ├── session.ts             # sesiones en memoria (UUID no enumerable)
│   ├── rules.ts               # matriz de controles RC1–RC10 + construcción del payload
│   ├── llm/
│   │   ├── adapter.ts         # interfaz neutra del proveedor
│   │   └── gemini.ts          # implementación REST para Gemini
│   ├── tools/oc.ts            # las 6 herramientas zod (oc_<export>)
│   ├── sap/
│   │   ├── adapter.ts         # contrato SapAdapter (interfaz obligatoria)
│   │   └── mock.ts            # SAP simulado con archivos (idempotente)
│   └── knowledge/ordenes-compra.md  # conocimiento del dominio
├── web/                       # front de chat (HTML plano + JS externo)
├── fixtures/                  # datos del reto (solo lectura, no se versionan cambios)
├── demo.ts                    # verificación sin modelo
├── modulo/                    # bonus: agente empaquetado como módulo reutilizable
└── SOLUCION.md                # arquitectura, decisiones, costos y diseño SAP real
```

## Herramientas del agente

| Herramienta | Entrada | Salida |
|---|---|---|
| `oc_leer_paquete` | `{ caso }` | Paquete normalizado (correo, solicitud, cotización, aprobación, factura?) |
| `oc_validar` | `{ caso, paquete? }` | `{ apta, bloqueos[], confirmaciones[], derivados, retroactiva }` |
| `oc_construir_payload` | `{ caso }` | `OrdenCompra` (esquema 7.4) + `out/<caso>/trazabilidad.json` |
| `oc_generar_evidencia` | `{ caso }` | `{ ruta, sha256 }` del anexo de aprobación |
| `oc_crear` | `{ caso, payload, confirmado? }` | `{ numero_oc, fecha, idempotente }` o error de bloqueo/confirmación |
| `oc_leer_excel` | `{ ruta }` | P1 opcional: declarada, devuelve error explícito en esta versión |

## Seguridad (OWASP)

- **Web:** validación zod de toda entrada, protección de path traversal en rutas de archivos, headers de seguridad (CSP, X-Frame-Options, nosniff), rate limit por IP, body con tope de tamaño, sesiones con UUID no enumerable, sin trazas crudas al cliente.
- **LLM:** las herramientas son la única fuente de valores (el modelo no puede afirmar datos que no salgan de ellas); argumentos de herramientas validados con zod; confirmación humana antes de crear OC con excepciones; defensa contra prompt injection indirecto en el system prompt (contenido de correos/cotizaciones tratado como dato); system prompt nunca expuesto por la API; topes de iteraciones y tokens por sesión; la clave del proveedor jamás sale del entorno del backend.

## Entrega

- Repositorio Git público con historial de commits: https://github.com/c0mm4nd1/reto-03-ordenes-compra-sap
- Demo sin modelo: `bun run demo.ts`
- Enlace público del chat: https://reto-03-ordenes-compra-sap.vercel.app
- Documentación técnica: [`SOLUCION.md`](./SOLUCION.md)
