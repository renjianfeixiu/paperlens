import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Separate entry: never ship the test harness or PDF data in the application.
export default defineConfig({
  plugins: [react()],
  build: { rollupOptions: { input: ["scripts/reader-smoke.html", "scripts/concept-smoke.html", "scripts/search-smoke.html"] } },
});
