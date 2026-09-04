import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  base: process.env.GITHUB_ACTIONS ? "/boardline/" : "/",
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
