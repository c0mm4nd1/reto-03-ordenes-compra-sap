import type { ToolDef, ToolContext } from "../tools/oc.js";

/**
 * Adaptador de proveedor LLM (sección 6.1 del PRD).
 *
 * Interfaz propia con un único método: el ciclo del agente (src/agent.ts)
 * solo habla con esta interfaz. Cambiar de Gemini a OpenAI/Anthropic/local
 * implica escribir una clase nueva, sin tocar el ciclo.
 *
 * Mensaje: formato neutral entre proveedores (system/user/assistant/tool).
 * LlmResponse: el modelo responde TEXTO, o pide llamar herramientas, o ambos.
 */

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCallRequest[] }
  | { role: "tool"; name: string; content: string };

export type ToolCallRequest = { id: string; name: string; arguments: unknown };

export type LlmResponse = {
  content: string | null;
  toolCalls: ToolCallRequest[];
  usage: { inputTokens: number; outputTokens: number };
};

/** Esquema de argumentos + descripción exportados para el formato del proveedor. */
export type ToolSpec = { name: string; description: string; args: Record<string, unknown> };

export function toToolSpecs(tools: Record<string, ToolDef<never>>): ToolSpec[] {
  return Object.entries(tools).map(([exportName, tool]) => ({
    name: `oc_${exportName}`,
    description: tool.description,
    args: tool.args as Record<string, unknown>,
  }));
}

export interface LlmAdapter {
  readonly provider: string;
  readonly model: string;
  enviar(mensajes: ChatMessage[], herramientas: ToolSpec[]): Promise<LlmResponse>;
}

/** Contexto extra que el backend pasa al adaptador (p.ej. el id de sesión para logs). */
export type LlmContext = ToolContext;
