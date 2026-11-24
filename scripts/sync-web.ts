import fsp from "node:fs/promises";
import path from "node:path";

/**
 * Genera src/webAssets.ts embebiendo web/index.html y web/app.js como
 * constantes TypeScript. En serverless (Vercel) el bundler solo incluye lo
 * importado por código: sin esto, los estáticos no llegarían a la función.
 *
 * Fuente única: web/ sigue siendo el original; este archivo es generado.
 *   bun run sync:web
 */

const root = process.cwd();

async function main() {
  const html = await fsp.readFile(path.join(root, "web", "index.html"), "utf8");
  const js = await fsp.readFile(path.join(root, "web", "app.js"), "utf8");
  const out = `// GENERADO por scripts/sync-web.ts — no editar a mano. Fuente: web/
export const INDEX_HTML = ${JSON.stringify(html)};
export const APP_JS = ${JSON.stringify(js)};
`;
  await fsp.writeFile(path.join(root, "src", "webAssets.ts"), out, "utf8");
  console.log("src/webAssets.ts generado desde web/.");
}

main().catch((err) => {
  console.error("sync:web falló:", (err as Error).message);
  process.exitCode = 1;
});
