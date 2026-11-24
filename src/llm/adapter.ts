import { z } from "zod";
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

export type ToolCallRequest = {
  id: string;
  name: string;
  arguments: unknown;
  /** Firma de pensamiento del modelo: Gemini exige reenviarla al replayar. */
  thoughtSignature?: string;
};

export type LlmResponse = {
  content: string | null;
  toolCalls: ToolCallRequest[];
  usage: { inputTokens: number; outputTokens: number };
};

/** Esquema de argumentos + descripción exportados para el formato del proveedor. */
export type ToolSpec = { name: string; description: string; args: Record<string, unknown> };

/**
 * Convierte un objeto de esquemas zod a JSON Schema para functionDeclarations.
 * Cobertura deliberadamente mínima (los tipos que usan las herramientas del
 * agente): string, number, boolean, object anidado y unknown/optional.
 */
export function zodToJsonSchema(shape: Record<string, z.ZodTypeAny>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, schema] of Object.entries(shape)) {
    const esOpcional = schema instanceof z.ZodOptional;
    const interno = esOpcional ? (schema as z.ZodOptional<z.ZodTypeAny>).unwrap() : schema;
    if (!esOpcional) required.push(key);
    properties[key] = convertirZod(interno, schema);
  }
  return { type: "OBJECT", properties, required };
}

function convertirZod(schema: z.ZodTypeAny, original: z.ZodTypeAny): Record<string, unknown> {
  const descripcion = original.description ?? schema.description;
  let out: Record<string, unknown>;
  if (schema instanceof z.ZodString) out = { type: "STRING" };
  else if (schema instanceof z.ZodBoolean) out = { type: "BOOLEAN" };
  else if (schema instanceof z.ZodNumber) out = { type: "NUMBER" };
  else if (schema instanceof z.ZodArray) out = { type: "ARRAY" };
  else if (schema instanceof z.ZodObject) out = zodToJsonSchema((schema as z.ZodObject<Record<string, z.ZodTypeAny>>).shape);
  else out = {}; // ZodUnknown/ZodAny: cualquier valor
  if (descripcion) out.description = descripcion;
  return out;
}

export function toToolSpecs(tools: Record<string, ToolDef<never>>): ToolSpec[] {
  return Object.entries(tools).map(([exportName, tool]) => ({
    name: `oc_${exportName}`,
    description: tool.description,
    args: zodToJsonSchema(tool.args as Record<string, z.ZodTypeAny>),
  }));
}

export interface LlmAdapter {
  readonly provider: string;
  readonly model: string;
  enviar(mensajes: ChatMessage[], herramientas: ToolSpec[]): Promise<LlmResponse>;
}

/** Contexto extra que el backend pasa al adaptador (p.ej. el id de sesión para logs). */
export type LlmContext = ToolContext;
