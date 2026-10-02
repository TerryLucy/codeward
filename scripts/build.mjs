import { build } from "esbuild";

const entries = {
  action: "src/action/index.ts",
  app: "src/app/index.ts",
  cli: "src/cli/index.ts",
};

const only = process.argv[2];

for (const [name, entry] of Object.entries(entries)) {
  if (only && only !== name) continue;
  await build({
    entryPoints: [entry],
    outfile: `dist/${name}/index.js`,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    sourcemap: false,
    minify: name !== "cli",
    legalComments: "none",
    banner: {
      js: [
        name === "cli" ? "#!/usr/bin/env node" : "",
        "import { createRequire as __cwCreateRequire } from 'node:module';",
        "const require = __cwCreateRequire(import.meta.url);",
      ].filter(Boolean).join("\n"),
    },
  });
  console.log(`built dist/${name}/index.js`);
}
