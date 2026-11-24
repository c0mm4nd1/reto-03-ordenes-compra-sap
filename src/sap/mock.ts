import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { SapAdapter } from "./adapter.js";
import type { OrdenCompra } from "../types.js";
import { safeJoin, writeFileEnsured } from "../lib/paths.js";

/**
 * SAP simulado con archivos (src/sap/mock.ts).
 *
 * Persistencia:
 *  - out/sap/ordenes.jsonl: una orden por línea, con hash de integridad.
 *  - out/sap/secuencia.txt: último número de OC emitido (empieza en 4500000000,
 *    así el primero asignado es 4500000001, según el PRD).
 *
 * Idempotencia (HU-5): crearOrden busca primero por solicitud_id. Si ya existe,
 * devuelve el número existente en lugar de crear una segunda OC. Esto hace que
 * reintentos, dobles clics o re-ejecuciones del agente sean seguros.
 */
export class MockSapAdapter implements SapAdapter {
  private readonly ordenesPath: string;
  private readonly secuenciaPath: string;
  /** Cadena de promesas que serializa las escrituras (mutex mínimo). */
  private lock: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly directory: string // raíz del proyecto
  ) {
    this.ordenesPath = safeJoin(directory, "out", "sap", "ordenes.jsonl");
    this.secuenciaPath = safeJoin(directory, "out", "sap", "secuencia.txt");
  }

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    // En el mock, la consulta la resuelve oc_validar leyendo el maestro;
    // aquí devolvemos null para mantener el contrato honesto (la validación
    // ya ocurrió antes de llegar al adaptador).
    void nit;
    return null;
  }

  async buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null> {
    if (!(await this.exists(this.ordenesPath))) return null;
    const raw = await fsp.readFile(this.ordenesPath, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const orden = JSON.parse(line) as { orden: OrdenCompra; numero_oc: string };
      if (orden.orden.referencia.solicitud_id === solicitud_id) {
        return { numero_oc: orden.numero_oc };
      }
    }
    return null;
  }

  async crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    // Serialización de las escrituras: evita condiciones de carrera si dos
    // turnos del agente crean órdenes al mismo tiempo.
    return this.enqueue(async () => {
      const existente = await this.buscarOrdenPorReferencia(orden.referencia.solicitud_id);
      if (existente) return { ...existente, fecha: this.today() };

      const siguiente = await this.siguienteNumero();
      const registro = {
        numero_oc: siguiente,
        fecha: this.today(),
        orden,
        integridad: createHash("sha256").update(JSON.stringify(orden)).digest("hex"),
      };
      await fsp.mkdir(path.dirname(this.ordenesPath), { recursive: true });
      await fsp.appendFile(this.ordenesPath, JSON.stringify(registro) + "\n", "utf8");
      return { numero_oc: siguiente, fecha: registro.fecha };
    });
  }

  /** Encolador mínimo: encadena las operaciones en una sola promesa. */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const result = this.lock.then(op);
    this.lock = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async siguienteNumero(): Promise<string> {
    const ACTUAL = 4500000000n;
    let ultimo = ACTUAL;
    if (await this.exists(this.secuenciaPath)) {
      const raw = (await fsp.readFile(this.secuenciaPath, "utf8")).trim();
      if (/^\d+$/.test(raw)) ultimo = BigInt(raw);
    }
    const siguiente = ultimo + 1n;
    await writeFileEnsured(this.secuenciaPath, siguiente.toString());
    return siguiente.toString();
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private async exists(p: string): Promise<boolean> {
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  }
}
