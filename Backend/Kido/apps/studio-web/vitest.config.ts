/**
 * Component tests run in jsdom, against the real components.
 *
 * The React plugin is the same one the application build uses. A separate JSX pipeline for tests
 * would be a second compiler that could disagree with the one that ships.
 *
 * Exported as a plain object rather than through `defineConfig`: this workspace pins its own Vite,
 * and `vitest/config` resolves the root one, so the two disagree about a plugin type that neither
 * runtime cares about.
 */
import react from "@vitejs/plugin-react";

export default {
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.tsx", "test/**/*.test.ts"],
    globals: false,
  },
};
