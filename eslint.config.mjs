// ESLint flat config: the recommended rules, Node globals for providers, scripts and tests, browser globals for the modules
// pages load from vendor/, and nothing that conflicts with Prettier, which owns formatting.
import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-config-prettier";

export default [
  { ignores: ["**/node_modules/", "**/.runtime/", "apps/files/vendor/marked/"] },
  js.configs.recommended,
  {
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: globals.node },
  },
  {
    rules: {
      // An empty catch is how this code says "this failure is expected and harmless".
      "no-empty": ["error", { allowEmptyCatch: true }],
      // `const { a, ...rest } = x` is the idiom for dropping a field.
      "no-unused-vars": ["error", { ignoreRestSiblings: true }],
    },
  },
  {
    files: ["vendor/**/*.mjs", "apps/*/vendor/**/*.mjs", "apps/*/vendor/**/*.js"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    // Some tests match page source as text, where literal spaces read more plainly than a {n} count.
    files: ["test/**/*.mjs"],
    rules: { "no-regex-spaces": "off" },
  },
  prettier,
];
