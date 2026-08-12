import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

const config = [
  ...nextCoreWebVitals,
  {
    ignores: ["supabase/functions/**", "node_modules/**", ".next/**"],
  },
];

export default config;
