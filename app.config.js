// Dynamic Expo config. ONE codebase — this only varies the app *identity*
// (bundle id / package / display name) by the injected EXPO_PUBLIC_ENV, exactly
// like utils/supabase.js varies the API URL by EXPO_PUBLIC_SUPABASE_URL. There is
// NO app/logic branch here: it's a data table selecting a string, so each env can
// be installed side-by-side (e.g. staging next to prod) instead of overwriting.
//
// Prod identity is intentionally LEFT UNCHANGED (empty suffix + label) so the App
// Store app id, push certs, RevenueCat app, and deep-link scheme stay untouched.
// EXPO_PUBLIC_ENV is set per build profile in eas.json (and .env.local for local
// dev); the default keeps a missing value safe.
//
// app.json remains the base config (passed in here as `config`); this overlays it.

const ENV = process.env.EXPO_PUBLIC_ENV ?? "development";

const VARIANTS = {
  development: { suffix: ".dev", label: " (Dev)" },
  preview: { suffix: ".staging", label: " (Staging)" },
  production: { suffix: "", label: "" },
};

const variant = VARIANTS[ENV] ?? VARIANTS.development;

export default ({ config }) => {
  const baseBundleId =
    config?.ios?.bundleIdentifier ?? "com.embrallc.ClientManagment";
  const baseAndroidPackage = config?.android?.package ?? baseBundleId;

  return {
    ...config,
    name: `${config.name}${variant.label}`,
    ios: {
      ...config.ios,
      bundleIdentifier: `${baseBundleId}${variant.suffix}`,
    },
    android: {
      ...config.android,
      package: `${baseAndroidPackage}${variant.suffix}`,
    },
  };
};
