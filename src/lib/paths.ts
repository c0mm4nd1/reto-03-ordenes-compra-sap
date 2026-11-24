import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";

/**
 * Resolución segura de rutas (OWASP A01/A03: path traversal).
 *
 * Toda lectura/escritura del proyecto pasa por aquí. La regla es:
 *  - Nunca se aceptan rutas absolutas ni que salgan del directorio base.
 *  - El resultado siempre queda dentro de `base`.
 *
 * Así, aunque el modelo LLM (o un usuario malicioso) envíe argumentos como
 * "../../etc/passwd", la herramienta los rechaza antes de tocar el disco.
 */
export function safeJoin(base: string, ...segments: string[]): string {
  // Los segmentos siempre son relativos a `base`: se normalizan quitando las
  // barras iniciales, porque path.resolve() reiniciaría la ruta ante un
  // segmento absoluto ("/index.html" sería "/" y no "<base>/index.html").
  const relativos = segments.map((s) => s.replace(/^[/\\]+/, ""));
  const resolved = path.resolve(base, ...relativos);
  const normalizedBase = path.resolve(base) + path.sep;
  if (resolved !== path.resolve(base) && !resolved.startsWith(normalizedBase)) {
    throw new Error(`Ruta fuera del directorio permitido: ${segments.join("/")}`);
  }
  return resolved;
}

export function fileExists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(p: string): Promise<T> {
  const raw = await fsp.readFile(p, "utf8");
  return JSON.parse(raw) as T;
}

/** Escribe un archivo creando los directorios padre de forma segura. */
export async function writeFileEnsured(p: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, content, "utf8");
}

/** Limpia el directorio out/ al inicio de cada ejecución (determinismo). */
export async function cleanOut(outDir: string): Promise<void> {
  await fsp.rm(outDir, { recursive: true, force: true });
  await fsp.mkdir(outDir, { recursive: true });
}

/** Normaliza un NIT comparando solo dígitos (ignora puntos y dígito de verificación). */
export function normalizeNit(nit: string): string {
  return nit.replace(/\D/g, "");
}

/**
 * Normaliza un nombre para comparación tolerante:
 * minúsculas, sin acentos, sin puntuación y espacios colapsados.
 */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parsea "2026-08-21T10:02:00-05:00" o "2026-08-21" a fecha local sin hora. */
export function toDateOnly(iso: string): string {
  return iso.slice(0, 10);
}

/** Compara dos fechas ISO (YYYY-MM-DD). Devuelve negativo si a < b. */
export function compareDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Formatea un número estilo SAP para el texto de la cotización: "95.000" -> 95000.
 * Acepta separador de miles "." y separador decimal ",".
 */
export function parseSapAmount(text: string): number {
  const cleaned = text.trim().replace(/\s/g, "");
  // Si tiene coma, la coma es el separador decimal; los puntos son miles.
  if (cleaned.includes(",")) {
    return Math.round(Number(cleaned.replace(/\./g, "").replace(",", ".")));
  }
  return Math.round(Number(cleaned.replace(/\./g, "")));
}

export function formatCOP(n: number): string {
  return `COP ${n.toLocaleString("es-CO")}`;
}
