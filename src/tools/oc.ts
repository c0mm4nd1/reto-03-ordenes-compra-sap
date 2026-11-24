import { z } from "zod";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  AprobacionSchema,
  CorreoSchema,
  OrdenCompraSchema,
  Paquete,
  SolicitudSchema,
  ToolResult,
} from "../types.js";
import {
  buildEvidenceBody,
  buildEvidenceContent,
  construirOrden,
  loadMaestros,
  parseCotizacion,
  parseFactura,
  sha256,
  validarPaquete,
} from "../rules.js";
import { fileExists, outPath, readAssetText, readJson, safeJoin, writeFileEnsured } from "../lib/paths.js";
import { logToolCall } from "../lib/logger.js";
import { MockSapAdapter } from "../sap/mock.js";

/**
 * Herramientas del agente de órdenes de compra (contrato 6.2 del PRD).
 *
 * Cada herramienta es un objeto { description, args, execute }:
 *  - `description`: una frase; es lo ÚNICO que el modelo lee para decidir cuándo llamarla.
 *  - `args`: esquemas zod; el backend valida antes de ejecutar y devuelve el
 *    error al modelo si no cumple (OWASP LLM05: salida del modelo validada).
 *  - `execute`: devuelve string JSON con { ok: true, data } o { ok: false, error }.
 *    NUNCA lanza excepción hacia el agente (HU-5/CA5).
 *
 * ctx.directory siempre es la raíz del proyecto: las rutas se resuelven con
 * safeJoin(), que bloquea path traversal (OWASP A01).
 */

/** Contexto que el backend inyecta en cada herramienta. */
export type ToolContext = { directory: string; sessionId: string };

/** Nombre del modelo = <archivo>_<export>: cada export se expone como herramienta. */
export type ToolArgs = Record<string, z.ZodTypeAny>;

/** Tipo inferido de los argumentos parseados a partir de los esquemas. */
export type InferArgs<A extends ToolArgs> = { [K in keyof A]: z.output<A[K]> };

export type ToolDef<A extends ToolArgs = ToolArgs> = {
  description: string;
  args: A;
  execute: (args: InferArgs<A>, ctx: ToolContext) => Promise<string>;
};

/** Serializa el resultado y lo registra en la bitácora (CA4). */
async function respond<A>(
  name: string,
  ctx: ToolContext,
  run: () => Promise<ToolResult>
): Promise<string> {
  let result: ToolResult;
  let ok = true;
  let resumen = "";
  try {
    result = await run();
    ok = result.ok;
    resumen = result.ok
      ? summarize(result.data)
      : (result as { ok: false; error: string }).error.slice(0, 200);
  } catch (err) {
    // Defensa en profundidad: aunque una regla falle inesperadamente, la
    // herramienta responde con error legible y la sesión no muere.
    ok = false;
    result = { ok: false, error: `Error interno de ${name}: ${(err as Error).message}` };
    resumen = (err as Error).message.slice(0, 200);
  }
  logToolCall(outPath(ctx.directory, "log.jsonl"), {
    ts: new Date().toISOString(),
    herramienta: name,
    ok,
    resumen,
    sessionId: ctx.sessionId,
  });
  return JSON.stringify(result);
}

function summarize(data: unknown): string {
  const s = JSON.stringify(data);
  return s.length > 200 ? s.slice(0, 197) + "..." : s;
}

/** Carga el paquete completo de un caso desde los fixtures (solo lectura). */
async function cargarPaquete(directory: string, caso: string): Promise<Paquete> {
  const base = safeJoin(directory, "fixtures", "reto-03", "solicitudes", caso);
  if (!fileExists(base)) throw new Error(`Caso inexistente: ${caso}`);

  const correo = CorreoSchema.parse(await readJson<unknown>(safeJoin(base, "correo.json")));
  const solicitud = SolicitudSchema.parse(await readJson<unknown>(safeJoin(base, "solicitud.json")));

  // Adjuntos ausentes se reportan como null, nunca como excepción (HU-1).
  const faltantes: string[] = [];
  const cotizacionPath = safeJoin(base, "cotizacion.txt");
  const cotizacion = fileExists(cotizacionPath)
    ? parseCotizacion(await readAssetText(cotizacionPath))
    : (faltantes.push("cotizacion.txt"), null);

  const aprobacionPath = safeJoin(base, "aprobacion.json");
  let aprobacion: Paquete["aprobacion"] = null;
  if (fileExists(aprobacionPath)) {
    const raw = AprobacionSchema.parse(await readJson<unknown>(aprobacionPath));
    // "Aprobado" se busca como palabra completa e insensible a mayúsculas.
    aprobacion = { ...raw, aprobado: /\baprobado\b/i.test(raw.cuerpo) };
  } else {
    faltantes.push("aprobacion.json");
  }

  const facturaPath = safeJoin(base, "factura.txt");
  const factura = fileExists(facturaPath)
    ? parseFactura(await readAssetText(facturaPath))
    : null;
  if (correo.adjuntos.includes("factura.pdf") && !factura) faltantes.push("factura.txt");

  return {
    correo: { id: correo.id, de: correo.de, asunto: correo.asunto, fecha: correo.fecha },
    solicitud,
    cotizacion,
    aprobacion,
    factura,
    adjuntos_faltantes: faltantes,
  };
}

/** Registra una fila en out/control.csv (HU-5): todo intento queda auditado. */
async function registrarControl(
  directory: string,
  fila: {
    solicitud_id: string;
    resultado: "creada" | "bloqueada" | "pendiente_confirmacion" | "idempotente";
    numero_oc: string;
    retroactiva: boolean;
    bloqueos: string;
    confirmaciones: string;
  }
): Promise<void> {
  const p = outPath(directory, "control.csv");
  const existe = fileExists(p);
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const linea = [
    fila.solicitud_id,
    fila.resultado,
    fila.numero_oc,
    fila.retroactiva ? "true" : "false",
    esc(fila.bloqueos),
    esc(fila.confirmaciones),
    new Date().toISOString(),
  ].join(",");
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.appendFile(p, (existe ? "" : "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts\n") + linea + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// oc_leer_paquete
// ---------------------------------------------------------------------------

export const leer_paquete: ToolDef<{ caso: z.ZodString }> = {
  description:
    "Lee el paquete completo de una solicitud de compra (correo, solicitud, cotización, aprobación y factura si existe) desde los fixtures y lo devuelve normalizado.",
  args: { caso: z.string().describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/ (ej. sol-001)") },
  async execute(args, ctx) {
    return respond("oc_leer_paquete", ctx, async () => {
      const paquete = await cargarPaquete(ctx.directory, args.caso);
      return { ok: true, data: { caso: args.caso, ...paquete } };
    });
  },
};

// ---------------------------------------------------------------------------
// oc_validar
// ---------------------------------------------------------------------------

export const validar: ToolDef<{ caso: z.ZodString; paquete: z.ZodOptional<z.ZodUnknown> }> = {
  description:
    "Aplica la matriz de controles RC1–RC10 al paquete de un caso y devuelve si la OC es apta, sus bloqueos, las confirmaciones que requiere y los valores derivados de los maestros.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso (ej. sol-001)"),
    // El paquete es opcional: si el modelo no lo pasa, la herramienta lo
    // recarga desde disco. Así el valor validado siempre sale del fixture.
    paquete: z.unknown().optional().describe("Paquete normalizado de oc_leer_paquete (opcional)"),
  },
  async execute(args, ctx) {
    return respond("oc_validar", ctx, async () => {
      const paquete = await cargarPaquete(ctx.directory, args.caso);
      const maestros = await loadMaestros(ctx.directory);
      const v = validarPaquete(paquete, maestros);
      return {
        ok: true,
        data: {
          caso: args.caso,
          apta: v.apta,
          retroactiva: v.retroactiva,
          bloqueos: v.bloqueos,
          confirmaciones: v.confirmaciones,
          derivados: v.derivados,
          adjuntos_faltantes: paquete.adjuntos_faltantes,
        },
      };
    });
  },
};

// ---------------------------------------------------------------------------
// oc_construir_payload
// ---------------------------------------------------------------------------

export const construir_payload: ToolDef<{ caso: z.ZodString }> = {
  description:
    "Construye el payload de la orden de compra tal como quedaría en SAP, con la tabla de trazabilidad de cada campo a su fuente. Solo usar cuando la validación no tenga bloqueos.",
  args: { caso: z.string().describe("Nombre de la carpeta del caso (ej. sol-001)") },
  async execute(args, ctx) {
    return respond("oc_construir_payload", ctx, async () => {
      const paquete = await cargarPaquete(ctx.directory, args.caso);
      const maestros = await loadMaestros(ctx.directory);
      const v = validarPaquete(paquete, maestros);
      if (!v.apta) {
        return { ok: false, error: `La solicitud tiene bloqueos (${v.bloqueos.map((b) => b.codigo).join(", ")}); no se puede construir el payload.` };
      }
      const evidenciaSha = paquete.aprobacion
        ? sha256(buildEvidenceContent(paquete.aprobacion))
        : "";
      const { orden, trazabilidad } = construirOrden(paquete, v, maestros, evidenciaSha);
      const ruta = outPath(ctx.directory, args.caso, "trazabilidad.json");
      await writeFileEnsured(ruta, JSON.stringify(trazabilidad, null, 2));
      return { ok: true, data: { caso: args.caso, payload: orden, trazabilidad_ruta: `out/${args.caso}/trazabilidad.json` } };
    });
  },
};

// ---------------------------------------------------------------------------
// oc_generar_evidencia
// ---------------------------------------------------------------------------

export const generar_evidencia: ToolDef<{ caso: z.ZodString }> = {
  description:
    "Genera el archivo de evidencia de la aprobación (aprobacion.txt con encabezados, cuerpo y sha256) para adjuntar a la OC, como requiere auditoría.",
  args: { caso: z.string().describe("Nombre de la carpeta del caso (ej. sol-001)") },
  async execute(args, ctx) {
    return respond("oc_generar_evidencia", ctx, async () => {
      const paquete = await cargarPaquete(ctx.directory, args.caso);
      if (!paquete.aprobacion) {
        return { ok: false, error: "No hay correo de aprobación para generar evidencia." };
      }
      const contenido = buildEvidenceContent(paquete.aprobacion);
      const ruta = outPath(ctx.directory, args.caso, "aprobacion.txt");
      await writeFileEnsured(ruta, contenido);
      // El hash es sobre el cuerpo canónico (mismo valor que queda en el payload).
      const hash = sha256(buildEvidenceBody(paquete.aprobacion) + "\n");
      return { ok: true, data: { caso: args.caso, ruta: `out/${args.caso}/aprobacion.txt`, sha256: hash } };
    });
  },
};

// ---------------------------------------------------------------------------
// oc_crear
// ---------------------------------------------------------------------------

export const crear: ToolDef<{
  caso: z.ZodString;
  payload: z.ZodUnknown;
  confirmado: z.ZodOptional<z.ZodBoolean>;
}> = {
  description:
    "Crea la orden de compra en el SAP simulado. Requiere que la validación no tenga bloqueos y, si hay confirmaciones pendientes, confirmado=true. Es idempotente por solicitud_id.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso (ej. sol-001)"),
    payload: z.unknown().describe("Payload OrdenCompra producido por oc_construir_payload"),
    confirmado: z.boolean().optional().describe("true solo cuando el usuario confirmó explícitamente las confirmaciones pendientes (CA3)"),
  },
  async execute(args, ctx) {
    return respond("oc_crear", ctx, async () => {
      // 1) El payload recibido del modelo se valida contra su esquema zod.
      const parsed = OrdenCompraSchema.safeParse(args.payload);
      if (!parsed.success) {
        return { ok: false, error: "Payload inválido: " + parsed.error.issues.map((i) => i.path.join(".")).join(", ") };
      }

      // 2) La herramienta NO confía en el modelo: revalida todo desde disco.
      const paquete = await cargarPaquete(ctx.directory, args.caso);
      const maestros = await loadMaestros(ctx.directory);
      const v = validarPaquete(paquete, maestros);
      const ids = { solicitud_id: paquete.solicitud.solicitud_id };

      if (!v.apta) {
        await registrarControl(ctx.directory, {
          ...ids,
          resultado: "bloqueada",
          numero_oc: "",
          retroactiva: v.retroactiva,
          bloqueos: v.bloqueos.map((b) => `${b.codigo}: ${b.detalle}`).join(" | "),
          confirmaciones: "",
        });
        return { ok: false, error: `Bloqueos: ${v.bloqueos.map((b) => b.detalle).join(" | ")}` };
      }

      if (v.confirmaciones.length > 0 && args.confirmado !== true) {
        await registrarControl(ctx.directory, {
          ...ids,
          resultado: "pendiente_confirmacion",
          numero_oc: "",
          retroactiva: v.retroactiva,
          bloqueos: "",
          confirmaciones: v.confirmaciones.map((c) => `${c.codigo}: ${c.detalle}`).join(" | "),
        });
        return {
          ok: false,
          error: `requiere confirmación: ${v.confirmaciones.map((c) => `[${c.codigo}] ${c.detalle}`).join(" | ")}`,
        };
      }

      // 3) Idempotencia: si ya existe una OC para esta solicitud, se devuelve.
      const sap = new MockSapAdapter(ctx.directory);
      const previa = await sap.buscarOrdenPorReferencia(paquete.solicitud.solicitud_id);
      if (previa) {
        await registrarControl(ctx.directory, {
          ...ids,
          resultado: "idempotente",
          numero_oc: previa.numero_oc,
          retroactiva: v.retroactiva,
          bloqueos: "",
          confirmaciones: "",
        });
        return { ok: true, data: { caso: args.caso, numero_oc: previa.numero_oc, idempotente: true, retroactiva: v.retroactiva } };
      }

      // 4) Se registran las excepciones confirmadas por el humano.
      const ordenConfirmada = {
        ...parsed.data,
        excepciones: parsed.data.excepciones.map((e) => ({
          ...e,
          confirmado_por: v.confirmaciones.length > 0 ? "analista (confirmación en chat)" : e.confirmado_por,
        })),
      };
      const { numero_oc, fecha } = await sap.crearOrden(ordenConfirmada);
      await registrarControl(ctx.directory, {
        ...ids,
        resultado: "creada",
        numero_oc,
        retroactiva: v.retroactiva,
        bloqueos: "",
        confirmaciones: v.confirmaciones.map((c) => c.codigo).join(";"),
      });
      return { ok: true, data: { caso: args.caso, numero_oc, fecha, idempotente: false, retroactiva: v.retroactiva } };
    });
  },
};

// ---------------------------------------------------------------------------
// oc_leer_excel (P1 opcional)
// ---------------------------------------------------------------------------

export const leer_excel: ToolDef<{ ruta: z.ZodString }> = {
  description:
    "P1 opcional: leería un archivo .xlsx del disco. En esta versión no está habilitado porque los fixtures llegan normalizados a solicitud.json.",
  args: { ruta: z.string().describe("Ruta relativa del .xlsx dentro del proyecto") },
  async execute(args, ctx) {
    return respond("oc_leer_excel", ctx, async () => {
      // Herramienta declarada para completar el contrato P1. Devuelve un
      // error explícito en lugar de fingir capacidad que no tiene.
      void args;
      void ctx;
      return { ok: false, error: "P1 no implementado: use oc_leer_paquete, que consume solicitud.json (Excel normalizado por el fixture)." };
    });
  },
};

/** Registro completo de herramientas: nombre visible para el modelo = oc_<export>. */
export const tools = {
  leer_paquete,
  validar,
  construir_payload,
  generar_evidencia,
  crear,
  leer_excel,
};
