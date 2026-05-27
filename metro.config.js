const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// @shopify/react-native-skia declares "react-native": "src/index.ts" in its
// package.json, which Metro picks up over "main". The TypeScript source contains
// `const enum` declarations that Babel cannot evaluate, causing a bundle failure.
// Redirect to the pre-compiled CommonJS output so Metro never touches the TS source.
const defaultResolveRequest = config.resolver.resolveRequest;

// Pre-resolved absolute path to the codegen-spec stub. Used to redirect any
// internal import of Skia's `specs/*NativeComponent*` files — the
// @react-native/babel-plugin-codegen transform fails on those at bundle time
// with "Could not find component config for native component" on Expo SDK 54.
// The native components are already registered by Skia's native build; the
// stub just satisfies the JS-side import.
const SKIA_SPEC_STUB = path.resolve(
  __dirname,
  "metro-stubs",
  "skia-native-component-stub.js",
);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "@shopify/react-native-skia") {
    return {
      filePath: require.resolve(
        "@shopify/react-native-skia/lib/module/index.js",
      ),
      type: "sourceFile",
    };
  }

  // Intercept Skia spec imports made from within the package
  // (e.g. `./specs/SkiaPictureViewNativeComponent` resolved relative to a
  // file under `react-native-skia/lib/...`).
  const isSkiaInternal =
    context.originModulePath &&
    context.originModulePath.includes(
      `${path.sep}@shopify${path.sep}react-native-skia${path.sep}`,
    );
  if (
    isSkiaInternal &&
    /NativeComponent(\.js)?$/.test(moduleName) &&
    moduleName.includes("specs/")
  ) {
    return { filePath: SKIA_SPEC_STUB, type: "sourceFile" };
  }

  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
