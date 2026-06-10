import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  {
    ignores: ["dist/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ["**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        require: "readonly",
        module: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        process: "readonly",
        Buffer: "readonly",
        console: "readonly",
        decodeEVMReceipts: "readonly", // QuickNode global function
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off", // CommonJS is standard for these Node.js scripts
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          varsIgnorePattern: "^main$", // QuickNode filter functions define main but don't call it
        },
      ],
    },
  },
  {
    files: ["**/*.ts"],
    ignores: ["**/*.mjs", "dist/**"],
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: __dirname,
      },
    },
  },
);
