import { randomUUID } from "node:crypto";
import { SessionState } from "./agent.js";

/**
 * Sesiones en memoria (sección 6.1 del PRD: sin base de datos).
 *
 * OWASP A01 (control de acceso): el id de sesión es un UUID v4 aleatorio de
 * 122 bits de entropía, no enumerable. Conocer/guessar un id no concede
 * privilegios adicionales (toda sesión puede usar las mismas herramientas de
 * solo-escritura en out/), pero blinda la lectura del historial de terceros.
 *
 * En Render (un solo proceso) la memoria basta; si se escala a varias
 * réplicas, este módulo es el único punto a sustituir por un store externo.
 */

const sesiones = new Map<string, SessionState>();

export function nuevaSesion(): SessionState {
  const session: SessionState = { id: randomUUID(), messages: [], tokensUsados: 0 };
  sesiones.set(session.id, session);
  return session;
}

export function obtenerSesion(id: string): SessionState | null {
  return sesiones.get(id) ?? null;
}

/** Historial visible: nunca incluye el system prompt (OWASP LLM07). */
export function historialVisible(s: SessionState) {
  return s.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role,
      content: m.content,
      toolCalls: m.role === "assistant" ? m.toolCalls : undefined,
    }));
}
