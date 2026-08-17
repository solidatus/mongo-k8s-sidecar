// @ts-check

// It can be helpful to look directly at the GH implementation of some of these libraries to see exactly what they do/don't do!
// ESLint rules: https://eslint.org/docs/latest/rules/
// TSLint rules: https://typescript-eslint.io/rules/
// Perfectionist rules: https://github.com/azat-io/eslint-plugin-perfectionist#rules

import eslint from "@eslint/js";
import perfectionist from "eslint-plugin-perfectionist";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended"; // Depends on package `eslint-config-prettier`
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  // Acts as global ignores, due to the absence of other properties
  {
    ignores: ["**/dist/"],
  },

  // Base JS rules
  eslint.configs.recommended,

  // Base TS rules (might override JS rules)
  ...tseslint.configs.recommendedTypeChecked, // Use *TypeChecked variant to enable Linting with Type Information

  // Global overrides
  {
    languageOptions: {
      parserOptions: {
        // Enable TypeScript project service to enable Linting with Type Information
        projectService: {
          allowDefaultProject: ["eslint.config.mjs"], // Temp, to allow `@ts-check` at top of file, until we can turn into .mts file with native Node TS support in ver 24
        },
      },
    },
    linterOptions: {
      // Prefer to specify configs in this file, not inline
      reportUnusedInlineConfigs: "error",
    },
    rules: {
      // Enable extra rules we like
      "no-alert": "error",
      "no-console": "error",
      "prefer-const": "error",
    },
  },

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

  // Prettier config
  // Needs to come LAST to disable all rules conflicting with Prettier
  // The plugin already enables `eslint-config-prettier`!!! See https://github.com/prettier/eslint-plugin-prettier
  eslintPluginPrettierRecommended,
]);
