import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST

const coreSrc = fileURLToPath(new URL("../../packages/core/src", import.meta.url))

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  resolve: {
    // @yaskawa/core ships TypeScript source; resolve it straight to the files
    // so Vite treats it as part of the app graph instead of a prebundled dep.
    alias: [
      { find: /^@yaskawa\/core$/, replacement: `${coreSrc}/index.ts` },
      { find: /^@yaskawa\/core\/(.*)$/, replacement: `${coreSrc}/$1.ts` }
    ]
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"]
    }
  }
}))
