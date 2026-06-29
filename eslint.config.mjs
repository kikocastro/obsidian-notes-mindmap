import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

// Mirrors the Obsidian community-plugin review scan: obsidianmd recommended +
// typescript-eslint type-checked. Scoped to the Obsidian plugin (src/graph.ts +
// src/obsidian). The VS Code adapter ships separately and isn't part of the
// Obsidian release.
export default tseslint.config(
  {
    ignores: [
      "main.js",
      "dist/**",
      "test/**",
      "*.config.*",
      "esbuild.config.mjs",
    ],
  },
  ...tseslint.configs.recommendedTypeChecked,
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // VS Code adapter: obsidian-specific DOM rules don't apply (no activeDocument
    // / createEl in a VS Code webview). ponytail: only the rules that misfire here.
    files: ["src/vscode/**/*.ts"],
    rules: {
      "obsidianmd/prefer-active-doc": "off",
      "obsidianmd/prefer-create-el": "off",
    },
  }
);
