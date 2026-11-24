import fsp from "node:fs/promises";

/**
 * Bitácora de ejecución de herramientas (CA4 del PRD).
 *
 * Cada llamada a herramienta queda registrada en out/log.jsonl con
 * { ts, herramienta, ok, resumen }. Es append-only y nunca contiene secretos
 * ni contenido de prompts: solo metadatos de la ejecución.
 *
 * La escritura usa UNA sola cadena de promesas a nivel de módulo, así las
 * líneas nunca se intercalan aunque varias herramientas corran en paralelo.
 */

export type ToolLogEntry = {
  ts: string;
  herramienta: string;
  ok: boolean;
  resumen: string;
  sessionId?: string;
};

let writeQueue: Promise<unknown> = Promise.resolve();

export function logToolCall(logPath: string, entry: ToolLogEntry): void {
  const line = JSON.stringify(entry) + "\n";
  writeQueue = writeQueue.then(() => fsp.appendFile(logPath, line, "utf8"));
}

/** Espera a que se vacíe la cola global (usar antes de terminar la demo). */
export async function drainLog(): Promise<void> {
  await writeQueue;
}
