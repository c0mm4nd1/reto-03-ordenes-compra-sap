import fsp from "node:fs/promises";
import path from "node:path";

/**
 * Genera src/dataAssets.ts embebiendo agent/prompt.md y todo fixtures/ como
 * constantes TS. En serverless (Vercel) solo viaja al bundle lo importado
 * por código; con esto el agente lee prompt y fixtures igual que en local.
 *
 * Fuente única: agent/prompt.md y fixtures/ siguen siendo los originales.
 *   bun run sync:data
 */

const root = process.cwd();
const assets: Record<string, string> = {};

async function walk(dir: string): Promise<void> {
  for (const entrada of await fsp.readdir(dir, { withFileTypes: true })) {
    const completo = path.join(dir, entrada.name);
    if (entrada.isDirectory()) await walk(completo);
    else {
      const rel = path.relative(root, completo);
      assets[rel] = await fsp.readFile(completo, "utf8");
    }
  }
}

async function main() {
  assets["agent/prompt.md"] = await fsp.readFile(path.join(root, "agent", "prompt.md"), "utf8");
  await walk(path.join(root, "fixtures"));
  const out = `// GENERADO por scripts/sync-data.ts — no editar a mano.
// Fuentes: agent/prompt.md y fixtures/ (solo lectura).
export const DATA_ASSETS: Record<string, string> = ${JSON.stringify(assets, null, 1)};
`;
  await fsp.writeFile(path.join(root, "src", "dataAssets.ts"), out, "utf8");
  console.log(`src/dataAssets.ts generado con ${Object.keys(assets).length} archivos.`);
}

main().catch((err) => {
  console.error("sync:data falló:", (err as Error).message);
  process.exitCode = 1;
});
