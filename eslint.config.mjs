import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

const coreWebVitalsWithOverrides = nextCoreWebVitals.map((entry) => {
  if (entry.rules?.["react-hooks/set-state-in-effect"]) {
    return {
      ...entry,
      rules: {
        ...entry.rules,
        "react-hooks/set-state-in-effect": "warn",
        "react-hooks/purity": "warn",
        "react-hooks/refs": "warn",
      },
    };
  }
  return entry;
});

export default [
  {
    ignores: [".next/**", "node_modules/**", "out/**", "public/**", "apps/**", "packages/**", ".worktrees/**", ".understand-anything/**"],
  },
  ...coreWebVitalsWithOverrides,
  ...nextTypeScript,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
      "@typescript-eslint/no-empty-object-type": "warn",
      "@typescript-eslint/ban-ts-comment": "warn",
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx", "**/__tests__/**", "test-*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
];
