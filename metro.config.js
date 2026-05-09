const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// @shopify/react-native-skia declares "react-native": "src/index.ts" in its
// package.json, which Metro picks up over "main". The TypeScript source contains
// `const enum` declarations that Babel cannot evaluate, causing a bundle failure.
// Redirect to the pre-compiled CommonJS output so Metro never touches the TS source.
const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "@shopify/react-native-skia") {
    return {
      filePath: require.resolve(
        "@shopify/react-native-skia/lib/module/index.js",
      ),
      type: "sourceFile",
    };
  }
  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
