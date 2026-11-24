import fsp from "node:fs/promises";
import path from "node:path";

/**
 * Genera la carpeta modulo/ (bonus del PRD 9.4) a partir de las fuentes
 * canónicas, para garantizar que las piezas del módulo sean LAS MISMAS que
 * usa la aplicación y no copias divergentes:
 *
 *   agent/prompt.md                        → modulo/agent.md
 *   src/tools/oc.ts (re-export)            → modulo/tools/oc.ts
 *   src/knowledge/ordenes-compra.md        → modulo/skill/ordenes-compra/SKILL.md
 *
 * Ejecutar tras cualquier cambio al prompt o al conocimiento:
 *   bun run sync:modulo
 */

const root = process.cwd();

async function main() {
  // 1) agent.md: el prompt ya lleva el frontmatter requerido (description,
  //    mode: primary, permission {edit: deny, bash: deny}).
  const prompt = await fsp.readFile(path.join(root, "agent", "prompt.md"), "utf8");
  await fsp.writeFile(path.join(root, "modulo", "agent.md"), prompt, "utf8");

  // 2) tools/oc.ts: re-export de la fuente única, importable sin el servidor.
  const reexport = `// Generado por scripts/sync-modulo.ts: no editar a mano.
// Re-exporta las herramientas canónicas para que el módulo se use sin el
// servidor HTTP (PRD 9.4: las piezas deben ser las mismas, no copias).
export * from "../../src/tools/oc.js";
`;
  await fsp.writeFile(path.join(root, "modulo", "tools", "oc.ts"), reexport, "utf8");

  // 3) SKILL.md: frontmatter obligatorio + cuerpo del conocimiento canónico.
  const knowledge = await fsp.readFile(
    path.join(root, "src", "knowledge", "ordenes-compra.md"),
    "utf8"
  );
  const skill = `---
name: ordenes-compra
description: Conocimiento del proceso de órdenes de compra de P_ITG — flujo as-is, matriz de controles RC1–RC10 y comportamiento esperado por caso.
---

${knowledge}`;
  await fsp.writeFile(
    path.join(root, "modulo", "skill", "ordenes-compra", "SKILL.md"),
    skill,
    "utf8"
  );

  console.log("modulo/ sincronizado desde las fuentes canónicas.");
}

main().catch((err) => {
  console.error("sync:modulo falló:", (err as Error).message);
  process.exitCode = 1;
});
