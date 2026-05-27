// Runtime stub for @shopify/react-native-skia's codegen-spec component
// declarations.
//
// Skia 2.x ships spec files like `lib/module/specs/SkiaPictureViewNativeComponent.js`
// for the New Architecture codegen pipeline. The @react-native/babel-plugin-codegen
// transform tries to parse those specs at JS bundle time and fails on Expo SDK 54
// with "Could not find component config for native component". The native module
// is already registered by Skia's native code in the dev build — the JS spec is
// only there for codegen tooling — so swapping it for a no-op at bundle time
// lets Metro through without breaking runtime rendering.
//
// Wired up in metro.config.js for any spec file under
// `node_modules/@shopify/react-native-skia/.../specs/*NativeComponent*`.

const { requireNativeComponent } = require("react-native");

// SkiaDomView, SkiaPictureView, etc. — the native side has these registered.
// We hand back a `requireNativeComponent` reference using a best-guess name
// derived from the spec file path so the existing Skia JS code that does
// `<SkiaPictureView ... />` still has a valid component reference.
function resolve(name) {
  try {
    return requireNativeComponent(name);
  } catch (_) {
    // If the native side doesn't have this view (e.g. older Skia native
    // build), fall back to a noop component so the bundle still loads.
    return () => null;
  }
}

module.exports = {
  __esModule: true,
  default: resolve("SkiaPictureView"),
  SkiaPictureView: resolve("SkiaPictureView"),
  SkiaDomView: resolve("SkiaDomView"),
};
