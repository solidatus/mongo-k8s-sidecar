import pluginJs from "@eslint/js";
import perfectionist from "eslint-plugin-perfectionist";
import prettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  { files: ["**/*.{js,mjs,cjs,ts}"] },
  { languageOptions: { globals: globals.browser } },
  { ignores: ["**/node_modules/", "dist/"] },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  perfectionist.configs["recommended-natural"],
  {
    rules: {
      "perfectionist/sort-imports": [
        "error",
        {
          groups: [["builtin", "external"], ["internal", "parent", "sibling"], "type"],
        },
      ],
      "perfectionist/sort-interfaces": [
        "error",
        {
          partitionByNewLine: true,
        },
      ],
      "perfectionist/sort-object-types": [
        "error",
        {
          partitionByNewLine: true,
        },
      ],
    },
  },
  prettier,
];
