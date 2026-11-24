// Punto de entrada serverless para Vercel (plan B de despliegue, sin tarjeta).
// Reutiliza el MISMO servidor del proyecto: no hay lógica duplicada.
// El build (vercel.json) compila src/ a dist/ con tsc antes de desplegar.
import { createServer } from "../dist/server.js";

const server = createServer();

// Un http.Server de Node enruta cada par 'request'; al emitirlo manualmente
// la petición serverless recorre el mismo pipeline que en local.
export default function handler(req, res) {
  server.emit("request", req, res);
}
