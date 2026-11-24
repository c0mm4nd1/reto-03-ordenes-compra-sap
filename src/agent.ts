import { z } from "zod";
import { ChatMessage, LlmAdapter, toToolSpecs, ToolCallRequest } from "./llm/adapter.js";
import { tools, ToolContext } from "./tools/oc.js";
import { readAssetText, safeJoin } from "./lib/paths.js";

/**
 * Ciclo del agente (sección 6.3 del PRD): prompt → modelo → llamadas a
 * herramientas → respuesta, con tope de iteraciones por turno (CA1).
 *
 * Decisiones clave de seguridad:
 *  - CA2: el modelo no puede afirmar un valor que no salga de una herramienta;
 *    las herramientas son la única fuente de datos del negocio.
 *  - OWASP LLM05: los argumentos de cada llamada a herramienta se validan con
 *    zod antes de ejecutar; lo que el modelo "inventa" se rechaza con error.
 *  - OWASP LLM06: las herramientas no ejecutan comandos de shell ni acceden a
 *    la red; la acción de mayor impacto (crear OC) exige confirmación humana.
 *  - OWASP LLM10: tope de iteraciones y tope acumulado de tokens por sesión.
 */

export type EjecucionTool = {
  name: string;
  args: unknown;
  ok: boolean;
  result: string;
};

export type TurnoResult = {
  reply: string;
  toolCalls: EjecucionTool[];
  needsConfirmation: boolean;
  usage: { inputTokens: number; outputTokens: number };
};

export type SessionState = {
  id: string;
  messages: ChatMessage[];
  tokensUsados: number;
};

const MAX_ITERATIONS = Number(process.env.MAX_ITERATIONS_PER_TURN ?? 25);
const MAX_TOKENS_SESION = Number(process.env.MAX_TOKENS_PER_SESSION ?? 20000);

let systemPromptCache: string | null = null;

/** Carga el system prompt desde su archivo Markdown (obligatorio: no embebido). */
export async function loadSystemPrompt(directory: string): Promise<string> {
  if (systemPromptCache) return systemPromptCache;
  const raw = await readAssetText(safeJoin(directory, "agent", "prompt.md"));
  // El system prompt nunca se expone por la API (OWASP LLM07).
  systemPromptCache = raw;
  return raw;
}

/** Ejecuta un turno de conversación: un mensaje del usuario, una respuesta del agente. */
export async function runTurno(
  session: SessionState,
  userMessage: string,
  llm: LlmAdapter,
  ctx: ToolContext
): Promise<TurnoResult> {
  const system = await loadSystemPrompt(ctx.directory);
  session.messages.push({ role: "user", content: userMessage });

  const ejecutadas: EjecucionTool[] = [];
  let usage = { inputTokens: 0, outputTokens: 0 };

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    if (session.tokensUsados >= MAX_TOKENS_SESION) {
      return finTurno(session, ejecutadas, usage,
        "Llegué al tope de consumo configurado para esta sesión. Reinicia la conversación para continuar.");
    }

    let respuesta;
    try {
      respuesta = await llm.enviar(
        [{ role: "system", content: system }, ...session.messages],
        toToolSpecs(tools as never)
      );
    } catch (err) {
      // CA5: error del proveedor en lenguaje claro; la sesión no muere.
      return finTurno(session, ejecutadas, usage, `Error del proveedor de IA: ${(err as Error).message}`);
    }

    usage.inputTokens += respuesta.usage.inputTokens;
    usage.outputTokens += respuesta.usage.outputTokens;
    session.tokensUsados += respuesta.usage.inputTokens + respuesta.usage.outputTokens;

    if (respuesta.toolCalls.length === 0) {
      // El modelo respondió texto: fin del turno.
      const reply = respuesta.content ?? "(sin respuesta)";
      session.messages.push({ role: "assistant", content: reply });
      return {
        reply,
        toolCalls: ejecutadas,
        needsConfirmation: detectaConfirmacionPendiente(ejecutadas),
        usage,
      };
    }

    // El modelo pidió herramientas: registramos su mensaje y ejecutamos cada
    // llamada, validando argumentos con zod (OWASP LLM05).
    session.messages.push({
      role: "assistant",
      content: respuesta.content,
      toolCalls: respuesta.toolCalls,
    });

    for (const call of respuesta.toolCalls) {
      const resultado = await ejecutarTool(call, ctx);
      ejecutadas.push(resultado);
      session.messages.push({ role: "tool", name: call.name, content: resultado.result });
    }
  }

  // CA1: se alcanzó el tope de iteraciones; respondemos con lo que hay.
  return finTurno(session, ejecutadas, usage,
    "Alcancé el tope de iteraciones para este turno. Te resumo lo que tengo y lo que falta.");
}

async function ejecutarTool(call: ToolCallRequest, ctx: ToolContext): Promise<EjecucionTool> {
  const nombre = call.name.startsWith("oc_") ? call.name.slice(3) : call.name;
  const registry = tools as unknown as Record<
    string,
    { args: Record<string, z.ZodTypeAny>; execute: (a: never, c: ToolContext) => Promise<string> }
  >;
  const tool = registry[nombre];
  if (!tool) {
    return { name: call.name, args: call.arguments, ok: false, result: JSON.stringify({ ok: false, error: `Herramienta desconocida: ${call.name}` }) };
  }
  // `args` es un objeto de esquemas; se envuelve en z.object para validar
  // el conjunto de argumentos de la llamada (OWASP LLM05).
  const chequeo = z.object(tool.args).safeParse(call.arguments);
  if (!chequeo.success) {
    // Argumentos inválidos: se devuelve al modelo para que corrija (CA5/HU-5).
    const detalle = chequeo.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return { name: call.name, args: call.arguments, ok: false, result: JSON.stringify({ ok: false, error: `Argumentos inválidos — ${detalle}` }) };
  }
  const result = await tool.execute(chequeo.data as never, ctx);
  let ok = true;
  try {
    ok = (JSON.parse(result) as { ok: boolean }).ok;
  } catch {
    ok = false;
  }
  return { name: call.name, args: call.arguments, ok, result };
}

/**
 * Heurística para resaltar el estado de confirmación en el front (CA3):
 * si la última ejecución terminó en "requiere confirmación", el turno pide
 * confirmación humana antes de proceder.
 */
function detectaConfirmacionPendiente(ejecutadas: EjecucionTool[]): boolean {
  const ultima = [...ejecutadas].reverse().find((e) => !e.ok);
  return !!ultima && ultima.result.toLowerCase().includes("requiere confirmación");
}

function finTurno(
  session: SessionState,
  ejecutadas: EjecucionTool[],
  usage: TurnoResult["usage"],
  reply: string
): TurnoResult {
  session.messages.push({ role: "assistant", content: reply });
  return {
    reply,
    toolCalls: ejecutadas,
    needsConfirmation: detectaConfirmacionPendiente(ejecutadas),
    usage,
  };
}
