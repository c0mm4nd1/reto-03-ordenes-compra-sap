import { z } from "zod";
import {
  ChatMessage,
  LlmAdapter,
  LlmResponse,
  ToolCallRequest,
  ToolSpec,
} from "./adapter.js";

/**
 * Adaptador para Google Gemini (generativelanguage.googleapis.com).
 *
 * Por qué REST directo y no SDK: una dependencia menos en la cadena de
 * suministro (OWASP LLM03/A06) y control total del timeout y del conteo de
 * tokens. La clave viaja solo en el header x-goog-api-key, jamás en el repo,
 * el front ni los logs (OWASP LLM02).
 */

// Contrato acotado de la respuesta de Gemini: solo lo que usamos.
const GeminiPartSchema = z.object({
  text: z.string().optional(),
  thoughtSignature: z.string().optional(),
  functionCall: z
    .object({
      name: z.string(),
      args: z.record(z.unknown()).optional(),
      thoughtSignature: z.string().optional(),
    })
    .optional(),
});

const GeminiResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z.object({ parts: z.array(GeminiPartSchema).optional() }).optional(),
      })
    )
    .optional(),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().optional(),
      candidatesTokenCount: z.number().optional(),
    })
    .optional(),
});

export class GeminiAdapter implements LlmAdapter {
  readonly provider = "gemini";
  private readonly apiKey: string;
  readonly model: string;
  private readonly baseUrl = "https://generativelanguage.googleapis.com/v1beta/models";
  private readonly timeoutMs: number;

  constructor(model?: string, timeoutMs = 60000) {
    this.apiKey = process.env.GEMINI_API_KEY ?? "";
    this.model = model || process.env.GEMINI_MODEL || "gemini-flash-latest";
    this.timeoutMs = timeoutMs;
  }

  get configured(): boolean {
    return this.apiKey.length > 0;
  }

  async enviar(mensajes: ChatMessage[], herramientas: ToolSpec[]): Promise<LlmResponse> {
    if (!this.configured) {
      throw new Error("GEMINI_API_KEY no configurada en el entorno del servidor.");
    }

    // Gemini separa system de los contenidos y usa "functionDeclarations".
    const system = mensajes.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const contents = mensajes
      .filter((m) => m.role !== "system")
      .map((m) => this.toGeminiContent(m));

    const body = {
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents,
      tools: herramientas.length
        ? [{ functionDeclarations: herramientas.map((t) => this.toDeclaration(t)) }]
        : undefined,
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      // Tope duro de salida por llamada (OWASP LLM10).
      generationConfig: { maxOutputTokens: 2048 },
    };

    const url = `${this.baseUrl}/${this.model}:generateContent`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error).name === "AbortError") throw new Error("Timeout del proveedor LLM.");
      throw new Error(`No se pudo contactar al proveedor LLM: ${(err as Error).message}`);
    }
    clearTimeout(timer);

    if (!res.ok) {
      // Mensaje de error acotado hacia el agente: se incluye el detalle que
      // da el proveedor (no contiene la clave) para depuración, truncado.
      const detalle = (await res.text()).slice(0, 300);
      throw new Error(`El proveedor LLM respondió ${res.status}: ${detalle}`);
    }

    const parsed = GeminiResponseSchema.parse(await res.json());
    const parts = parsed.candidates?.[0]?.content?.parts ?? [];

    const toolCalls: ToolCallRequest[] = parts
      .filter((p) => p.functionCall)
      .map((p, i) => ({
        id: `call_${Date.now()}_${i}`,
        name: p.functionCall!.name,
        arguments: p.functionCall!.args ?? {},
        thoughtSignature: p.functionCall!.thoughtSignature ?? p.thoughtSignature,
      }));

    return {
      content: parts.map((p) => p.text ?? "").join("").trim() || null,
      toolCalls,
      usage: {
        inputTokens: parsed.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: parsed.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  }

  /** Traduce nuestro formato neutral al de Gemini. */
  private toGeminiContent(m: ChatMessage) {
    switch (m.role) {
      case "user":
        return { role: "user", parts: [{ text: m.content }] };
      case "assistant":
        return {
          role: "model",
          parts: [
            // Las llamadas a herramienta del asistente se reenvían como functionCall
            // (con su thoughtSignature) para que Gemini mantenga el contexto.
            ...(m.toolCalls ?? []).map((c) => ({
              functionCall: {
                name: c.name,
                args: c.arguments as Record<string, unknown>,
                ...(c.thoughtSignature ? { thoughtSignature: c.thoughtSignature } : {}),
              },
            })),
            ...(m.content ? [{ text: m.content }] : []),
          ],
        };
      case "tool":
        // Resultado de herramienta: la API actual de Gemini exige que los
        // functionResponse viajen como contenido de rol "user".
        return { role: "user", parts: [{ functionResponse: { name: m.name, response: { result: m.content } } }] };
      default:
        throw new Error(`Rol no soportado: ${(m as ChatMessage).role}`);
    }
  }

  /** Declaración de función con parámetros JSON Schema convertidos desde zod. */
  private toDeclaration(t: ToolSpec) {
    return {
      name: t.name,
      description: t.description,
      parameters: t.args,
    };
  }
}
