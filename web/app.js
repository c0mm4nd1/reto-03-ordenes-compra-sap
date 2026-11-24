/**
 * Front del chat (script externo: la CSP prohíbe scripts inline, OWASP A03).
 *
 * Muestra el historial, el indicador de "pensando", CADA llamada a herramienta
 * (nombre, argumentos, resultado) y resalta cuando el agente pide confirmación
 * humana (CA3). No contiene secretos: solo habla con nuestra propia API.
 */

const chat = document.getElementById("chat");
const form = document.getElementById("entrada");
const input = document.getElementById("mensaje");
const boton = document.getElementById("enviar");
const pensando = document.getElementById("pensando");
const estado = document.getElementById("estado");

let sessionId = null;

/** XSS: todo texto se inserta como textContent, nunca como innerHTML. */
function agregar(clase, texto) {
  const div = document.createElement("div");
  div.className = clase;
  div.textContent = texto;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}

function mostrarToolCalls(toolCalls) {
  for (const t of toolCalls) {
    const div = document.createElement("div");
    div.className = "tool";
    const titulo = document.createElement("div");
    titulo.innerHTML = ""; // sin contenido dinámico por innerHTML
    const nombre = document.createElement("span");
    nombre.className = "nombre";
    nombre.textContent = `⚙ ${t.name}`;
    const estadoTool = document.createElement("span");
    estadoTool.className = t.ok ? "" : "error";
    estadoTool.textContent = t.ok ? " ✓" : " ✗ error";
    titulo.appendChild(nombre);
    titulo.appendChild(estadoTool);

    const detalle = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "argumentos y resultado";
    const cuerpo = document.createElement("pre");
    cuerpo.style.margin = "6px 0 0";
    cuerpo.style.whiteSpace = "pre-wrap";
    cuerpo.textContent = JSON.stringify({ args: t.args, result: t.result }, null, 2);
    detalle.appendChild(summary);
    detalle.appendChild(cuerpo);

    div.appendChild(titulo);
    div.appendChild(detalle);
    chat.appendChild(div);
  }
  chat.scrollTop = chat.scrollHeight;
}

async function enviar(texto) {
  if (!texto.trim()) return;
  agregar("msg user", texto);
  input.value = "";
  boton.disabled = true;
  pensando.style.display = "block";
  chat.scrollTop = chat.scrollHeight;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message: texto }),
    });
    const data = await res.json();
    if (!res.ok) {
      agregar("msg assistant", `Error (${res.status}): ${data.error ?? "desconocido"}`);
      return;
    }
    sessionId = data.sessionId;
    mostrarToolCalls(data.toolCalls ?? []);
    // CA3: el estado de confirmación se resalta visualmente.
    agregar(data.needsConfirmation ? "msg confirmacion" : "msg assistant", data.reply);
  } catch {
    agregar("msg assistant", "No pude contactar al servidor. Intenta de nuevo.");
  } finally {
    boton.disabled = false;
    pensando.style.display = "none";
    chat.scrollTop = chat.scrollHeight;
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  enviar(input.value);
});

for (const btn of document.querySelectorAll(".sugerencia button")) {
  btn.addEventListener("click", () => enviar(btn.dataset.msg));
}

// Salud del backend en la cabecera (sin claves: /api/health no las expone).
fetch("/api/health")
  .then((r) => r.json())
  .then((h) => {
    estado.textContent = `${h.provider}/${h.model} · ${h.llmConfigured ? "listo" : "sin clave LLM"}`;
  })
  .catch(() => {
    estado.textContent = "backend no responde";
  });
