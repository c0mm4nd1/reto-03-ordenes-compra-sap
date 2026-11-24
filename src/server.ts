import http from "node:http";
import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { runTurno } from "./agent.js";
import { historialVisible, nuevaSesion, obtenerSesion } from "./session.js";
import { GeminiAdapter } from "./llm/gemini.js";
import { safeJoin } from "./lib/paths.js";
import { APP_JS, INDEX_HTML } from "./webAssets.js";

/**
 * Servidor HTTP del agente (API 6.4 del PRD + front estático).
 *
 * Medidas OWASP Web Top 10 aplicadas:
 *  - A05 Misconfiguración: headers de seguridad en TODA respuesta.
 *  - A03 Inyección: body JSON con límite de tamaño; entradas validadas con zod;
 *    rutas de archivos servidos solo desde web/ vía safeJoin (anti path traversal).
 *  - A02 Fallos criptográficos: nunca se loguea ni devuelve la clave del LLM.
 *  - A09 Logging: cada request queda con método, ruta y status (sin bodies).
 *  - A04 Diseño inseguro: toda acción con efectos pasa por las herramientas y
 *    su confirmación humana; el chat solo orquesta.
 *
 * Rate limit (OWASP API4 / LLM10): ventana deslizante en memoria por IP.
 */

const PORT = Number(process.env.PORT ?? 3000);
const WEB_DIR = safeJoin(process.cwd(), "web");
const RATE_WINDOW = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
const RATE_MAX = Number(process.env.RATE_LIMIT_MAX_REQUESTS ?? 12);

const llm = new GeminiAdapter();

// --- Esquemas de entrada (toda entrada externa se valida) -------------------

const ChatBodySchema = z.object({
  sessionId: z.string().uuid().optional(), // sin sessionId se crea una sesión nueva
  message: z.string().min(1).max(2000), // tope anti abuso del contexto (LLM10)
});

// --- Rate limiter en memoria -------------------------------------------------

const hits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const ahora = Date.now();
  const ventana = (hits.get(ip) ?? []).filter((t) => ahora - t < RATE_WINDOW);
  if (ventana.length >= RATE_MAX) {
    hits.set(ip, ventana);
    return true;
  }
  ventana.push(ahora);
  hits.set(ip, ventana);
  return false;
}

// --- Utilidades HTTP ----------------------------------------------------------

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; script-src 'self'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

/** Lee el body con tope de tamaño: evita payloads gigantes (DoS, LLM10). */
function readBody(req: http.IncomingMessage, limite = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > limite) {
        reject(new Error("Body demasiado grande"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function clientIp(req: http.IncomingMessage): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
}

// --- Router -------------------------------------------------------------------

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL, pathname: string): Promise<void> {
  // GET /api/health — diagnóstico sin exponer claves (6.4).
  if (pathname === "/api/health" && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      provider: llm.provider,
      model: llm.model,
      llmConfigured: llm.configured,
    });
  }

  // POST /api/chat — { sessionId?, message } → { reply, toolCalls[], needsConfirmation }.
  if (pathname === "/api/chat" && req.method === "POST") {
    const ip = clientIp(req);
    if (rateLimited(ip)) {
      return json(res, 429, { error: "Demasiadas solicitudes. Espera un minuto e intenta de nuevo." });
    }

    let raw: unknown;
    try {
      raw = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: "Body inválido: se espera JSON." });
    }
    const chequeo = ChatBodySchema.safeParse(raw);
    if (!chequeo.success) {
      return json(res, 400, { error: "Entrada inválida: message es obligatorio (máx. 2000 caracteres)." });
    }
    const { sessionId, message } = chequeo.data;

    const session = (sessionId && obtenerSesion(sessionId)) || nuevaSesion();
    try {
      const turno = await runTurno(session, message, llm, { directory: process.cwd(), sessionId: session.id });
      return json(res, 200, {
        sessionId: session.id,
        reply: turno.reply,
        toolCalls: turno.toolCalls,
        needsConfirmation: turno.needsConfirmation,
      });
    } catch (err) {
      // Sin trazas crudas al cliente (A05): mensaje genérico, detalle en servidor.
      console.error("[chat] error no controlado:", (err as Error).message);
      return json(res, 500, { error: "Error interno procesando el mensaje. La sesión sigue activa." });
    }
  }

  // GET /api/sessions/:id — historial completo, sin system prompt (LLM07).
  const match = /^\/api\/sessions\/([a-f0-9-]{36})$/.exec(pathname);
  if (match && req.method === "GET") {
    const session = obtenerSesion(match[1]!);
    if (!session) return json(res, 404, { error: "Sesión no encontrada." });
    return json(res, 200, { sessionId: session.id, messages: historialVisible(session) });
  }

  return json(res, 404, { error: "Ruta no encontrada." });
}

async function serveStatic(res: http.ServerResponse, url: URL): Promise<void> {
  const ruta = url.pathname === "/" ? "/index.html" : url.pathname;
  try {
    const archivo = safeJoin(WEB_DIR, ruta);
    const data = await fsp.readFile(archivo);
    const tipo = path.extname(archivo) === ".html" ? "text/html; charset=utf-8" : "text/plain; charset=utf-8";
    res.writeHead(200, { "Content-Type": tipo, ...SECURITY_HEADERS });
    res.end(data);
    return;
  } catch {
    // Serverless (Vercel): los estáticos no viajan en el bundle de la
    // función; se sirven embebidos desde src/webAssets.ts (fuente: web/).
    if (ruta === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS });
      res.end(INDEX_HTML);
      return;
    }
    if (ruta === "/app.js") {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", ...SECURITY_HEADERS });
      res.end(APP_JS);
      return;
    }
    json(res, 404, { error: "No encontrado" });
  }
}

export function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    // En Vercel, la rewrite envía todo a /api/bundle?path=<ruta-original>;
    // se reconstruye el path original para enrutar igual que en local.
    const rewritten = url.searchParams.get("path");
    const effectivePath = (rewritten !== null ? "/" + rewritten : url.pathname).replace(/\/{2,}/g, "/") || "/";
    try {
      if (effectivePath.startsWith("/api/")) {
        await handleApi(req, res, url, effectivePath);
      } else if (req.method === "GET") {
        await serveStatic(res, new URL(effectivePath, "http://localhost"));
      } else {
        json(res, 405, { error: "Método no permitido" });
      }
    } catch (err) {
      console.error("[http] error:", (err as Error).message);
      if (!res.headersSent) json(res, 500, { error: "Error interno del servidor." });
    }
    // A09: log mínimo de acceso, sin cuerpos ni datos sensibles.
    console.log(`${req.method} ${url.pathname} → ${res.statusCode}`);
  });
}

// Arranque directo: `npm run dev` / `bun run dev` (sección 8: un comando).
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  createServer().listen(PORT, () => {
    console.log(`Agente de órdenes de compra en http://localhost:${PORT}`);
    console.log(`Proveedor LLM: ${llm.provider}/${llm.model} (${llm.configured ? "configurado" : "SIN CLAVE — solo demo.ts funcionará"})`);
  });
}

/**
 * Handler serverless (Vercel): el runtime de Vercel exige un default export
 * función/servidor en el módulo de entrada. Enruta la petición por el mismo
 * pipeline HTTP que en local; no interfiere con el arranque directo.
 */
export default function serverlessHandler(req: http.IncomingMessage, res: http.ServerResponse) {
  createServer().emit("request", req, res);
}
