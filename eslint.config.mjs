import coreWebVitals from "eslint-config-next/core-web-vitals"
import nextTypescript from "eslint-config-next/typescript"

// ESLint 9 flat config.
//
// The repo shipped a `lint` script with neither eslint nor a config installed, so
// `pnpm lint` failed with "eslint is not recognized" and nothing was ever linted.
// This makes the script real.
//
// eslint-config-next 16 exports native flat configs from its `./core-web-vitals`
// and `./typescript` subpaths, so they are imported directly. Do not wrap them in
// FlatCompat from @eslint/eslintrc: that treats them as legacy eslintrc objects
// and dies with "Converting circular structure to JSON".
const asArray = (config) => (Array.isArray(config) ? config : [config])

const config = [
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts", "supabase/**", "dist/**"],
  },

  ...asArray(coreWebVitals),
  ...asArray(nextTypescript),

  {
    rules: {
      // The API routes log through console on purpose, for Vercel's log drain.
      // That output is how a failed CRM field resolution is diagnosed at all, see
      // resolveContactCustomFields in lib/ghl.ts.
      "no-console": "off",

      // Respect the leading-underscore convention for deliberately unused
      // bindings, rather than deleting code that documents a shape.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },

  {
    // API route handlers are server-side request handlers. There is no React and
    // no render, so the React Hooks rules cannot apply.
    //
    // Without this, `react-hooks/rules-of-hooks` reports 4 errors against
    // `useMockExtraction` in app/api/analyze and app/api/report-email. That
    // function is a plain helper; the rule flags it purely because the name
    // starts with "use", which is the heuristic it uses to spot hooks.
    //
    // Renaming it to something like `buildMockExtraction` would be the better
    // long-term fix, since it is not a hook and the name misleads a reader too.
    // That is a code change in the credit-analyzer path rather than a lint setup
    // change, so it is left alone here.
    files: ["app/api/**/*.ts", "app/api/**/*.tsx"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
    },
  },
]

export default config
