// Spooner's own lint gate (dogfood): typescript-eslint recommended on the
// zero-build scripts and tests. md/yaml stay with markdownlint-cli2 / prettier
// is checked by the `lint` script for js/ts only (no formatter conflicts).
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules/**", ".venv/**", "dist/**", "assets/**"],
  },
  ...tseslint.configs.recommended,
);
