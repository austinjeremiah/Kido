import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Localhost only. The Studio API holds build state and speaks to a Docker daemon; there is no
    // reason for either to be reachable from the network.
    host: "127.0.0.1",
    port: 4311,
    proxy: { "/api": { target: "http://127.0.0.1:4310", changeOrigin: true } },
  },
});
