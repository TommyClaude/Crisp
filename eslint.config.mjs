import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "next-env.d.ts",
      "src/generated/**",
    ],
  },
  {
    rules: {
      // rawJson blobs and Crisp API payloads are inherently untyped; we
      // validate at the boundaries with Zod instead.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];

export default eslintConfig;
