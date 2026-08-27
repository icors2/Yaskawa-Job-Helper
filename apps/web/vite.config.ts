import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const coreSrc = fileURLToPath(new URL("../../packages/core/src", import.meta.url))

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // @yaskawa/core ships TypeScript source; resolve it straight to the files
    // so Vite treats it as part of the app graph instead of a prebundled dep.
    alias: [
      { find: /^@yaskawa\/core$/, replacement: `${coreSrc}/index.ts` },
      { find: /^@yaskawa\/core\/(.*)$/, replacement: `${coreSrc}/$1.ts` }
    ]
  },
  server: {
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
})
