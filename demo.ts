/**
 * demo.ts — Verificación sin modelo de lenguaje (sección 6.6 del PRD).
 *
 * Ejecuta los 6 casos de fixtures/reto-03/solicitudes/ llamando DIRECTAMENTE
 * a las herramientas (sin LLM), demostrando determinismo y robustez:
 *
 *   npm install && npm run demo        (o: bun install && bun run demo.ts)
 *
 * Flujo por caso: leer_paquete → validar → (construir_payload +
 * generar_evidencia + crear). Los casos con confirmaciones se intentan primero
 * SIN confirmar (deben quedar pendientes) y luego con confirmado=true.
 * sol-001 se procesa dos veces para evidenciar la idempotencia (HU-5).
 */

import { tools } from "./src/tools/oc.js";
import { cleanOut, outRoot } from "./src/lib/paths.js";
import { drainLog } from "./src/lib/logger.js";

const directory = process.cwd();
const ctx = { directory, sessionId: "demo" };

type Fila = {
  caso: string;
  apta: string;
  bloqueos: string;
  confirmaciones: string;
  retro: string;
  oc: string;
};

const filas: Fila[] = [];

/** Ejecuta una herramienta y devuelve el objeto parseado de su resultado. */
async function run<T>(name: string, args: unknown): Promise<{ ok: boolean; data?: T; error?: string }> {
  const tool = (tools as Record<string, { execute: (a: unknown, c: typeof ctx) => Promise<string> }>)[name];
  if (!tool) throw new Error(`Herramienta no encontrada: ${name}`);
  return JSON.parse(await tool.execute(args, ctx)) as { ok: boolean; data?: T; error?: string };
}

async function procesarCaso(caso: string, opciones: { intentarSinConfirmar?: boolean; confirmar?: boolean } = {}) {
  const leido = await run<{ solicitud: { solicitud_id: string; valor_total: number; proveedor_nombre: string } }>(
    "leer_paquete",
    { caso }
  );
  if (!leido.ok || !leido.data) {
    filas.push({ caso, apta: "—", bloqueos: leido.error ?? "error", confirmaciones: "", retro: "", oc: "" });
    return;
  }

  const val = await run<{
    apta: boolean;
    retroactiva: boolean;
    bloqueos: { codigo: string; detalle: string }[];
    confirmaciones: { codigo: string; detalle: string }[];
  }>("validar", { caso });
  const v = val.data!;
  const fila: Fila = {
    caso,
    apta: v.apta ? "sí" : "no",
    bloqueos: v.bloqueos.map((b) => b.codigo).join(", "),
    confirmaciones: v.confirmaciones.map((c) => c.codigo).join(", "),
    retro: v.retroactiva ? "SÍ" : "no",
    oc: "",
  };

  if (!v.apta) {
    console.log(`\n■ ${caso} → BLOQUEADA (${fila.bloqueos})`);
    for (const b of v.bloqueos) console.log(`   [${b.codigo}] ${b.detalle}`);
    filas.push(fila);
    return;
  }

  const payload = await run<{ payload: unknown }>("construir_payload", { caso });
  if (!payload.ok) {
    fila.oc = `error: ${payload.error}`;
    filas.push(fila);
    return;
  }
  await run("generar_evidencia", { caso });

  // Casos con confirmaciones: primero el intento sin confirmar (debe fallar).
  if (opciones.intentarSinConfirmar && v.confirmaciones.length > 0) {
    const rechazada = await run("crear", { caso, payload: payload.data!.payload, confirmado: false });
    console.log(`\n■ ${caso} → intento sin confirmar: ${rechazada.ok ? "ERROR (no debió crear)" : `rechazada correctamente (${rechazada.error?.slice(0, 80)}...)`}`);
  }

  const crear = await run<{ numero_oc: string; idempotente: boolean }>("crear", {
    caso,
    payload: payload.data!.payload,
    confirmado: opciones.confirmar ?? false,
  });
  if (crear.ok && crear.data) {
    fila.oc = crear.data.idempotente
      ? `${crear.data.numero_oc} (idempotente)`
      : crear.data.numero_oc;
    console.log(`\n■ ${caso} → OC ${fila.oc}${v.confirmaciones.length ? " (con confirmación humana)" : ""}`);
  } else {
    fila.oc = `pendiente: ${crear.error?.slice(0, 90)}`;
    console.log(`\n■ ${caso} → ${fila.oc}`);
  }
  filas.push(fila);
}

async function main() {
  console.log("=".repeat(78));
  console.log("DEMO — Agente de Órdenes de Compra (herramientas sin LLM)");
  console.log("=".repeat(78));

  // Determinismo: out/ se limpia al inicio (sección 8 del PRD). Respeta
  // OUT_DIR para entornos serverless donde el cwd es de solo lectura.
  await cleanOut(outRoot(directory));

  // Caso feliz: sin intervención humana (O1).
  await procesarCaso("sol-001");
  // Idempotencia: segunda ejecución de sol-001 no crea una OC nueva (HU-5).
  await procesarCaso("sol-001");
  // Bloqueos: proveedor inexistente (RC1) y aprobador sin autoridad (RC2).
  await procesarCaso("sol-002");
  await procesarCaso("sol-003");
  // Confirmaciones: cotización con 6% de desviación (RC5).
  await procesarCaso("sol-004", { intentarSinConfirmar: true, confirmar: true });
  // Retroactiva: factura anterior a la solicitud (RC8) + sin IVA informado (RC6/RC7).
  await procesarCaso("sol-005", { intentarSinConfirmar: true, confirmar: true });
  await procesarCaso("sol-006", { intentarSinConfirmar: true, confirmar: true });

  await drainLog();

  console.log("\n" + "=".repeat(78));
  console.log("RESUMEN");
  console.log("=".repeat(78));
  const header = ["caso", "apta", "bloqueos", "conf.", "retroactiva", "OC"].map((h) => h.padEnd(14)).join("");
  console.log(header);
  console.log("-".repeat(78));
  for (const f of filas) {
    console.log(
      [f.caso, f.apta, f.bloqueos, f.confirmaciones, f.retro, f.oc].map((c) => (c ?? "").padEnd(14)).join("")
    );
  }
  console.log("\nArtefactos generados en out/: control.csv, log.jsonl, sap/ordenes.jsonl,");
  console.log("aprobacion.txt y trazabilidad.json por caso.");
}

main().catch((err) => {
  console.error("La demo falló:", (err as Error).message);
  process.exitCode = 1;
});
