// Conditionally render children when `guard` evaluates truthy.
//
// Usage:
//   <Guard guard={userProfile === "owner"}>
//     <OwnerOnlyThing />
//   </Guard>
//
// Optional `fallback` renders when the guard is falsy:
//   <Guard guard={isPro} fallback={<UpsellRow />}>
//     <ProFeatures />
//   </Guard>
//
// Functionally equivalent to `{condition && children}` but reads as a
// permission gate at the call site, which is the intent in most places we
// use it (owner/admin checks, feature flags, loading states).
export function Guard({ guard, children, fallback = null }) {
  return guard ? children : fallback;
}
