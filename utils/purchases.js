import { Platform } from "react-native";
import Purchases, { LOG_LEVEL } from "react-native-purchases";
import RevenueCatUI, { PAYWALL_RESULT } from "react-native-purchases-ui";
import { logError } from "../db/logs";

// Test Store key — full purchase flow works against RevenueCat's simulator.
// Replace with separate iOS/Android production keys before store submission.
const API_KEY_IOS = "test_qiUnPrUuAJAugaWbUOnLjyDOxwL";
const API_KEY_ANDROID = "test_qiUnPrUuAJAugaWbUOnLjyDOxwL";

export const ENTITLEMENT_ID = "Embra LLC Pro";

export function configurePurchases() {
  Purchases.setLogLevel(__DEV__ ? LOG_LEVEL.VERBOSE : LOG_LEVEL.ERROR);
  const apiKey = Platform.OS === "ios" ? API_KEY_IOS : API_KEY_ANDROID;
  Purchases.configure({ apiKey });
}

// Tie the RevenueCat customer to the Supabase auth uid. This is what lets the
// revenuecat-webhook map a purchase back to an org (app_user_id === auth uid),
// so it MUST run before any paywall is shown.
export async function logInPurchases(supabaseUid) {
  try {
    const { customerInfo } = await Purchases.logIn(supabaseUid);
    return customerInfo;
  } catch (e) {
    logError(e, "logInPurchases");
    return null;
  }
}

// Back to an anonymous RevenueCat user on sign-out so the next account on
// this device doesn't inherit the previous customer identity.
export async function logOutPurchases() {
  try {
    await Purchases.logOut();
  } catch (e) {
    // Throws if already anonymous — harmless.
  }
}

export async function fetchCustomerInfo() {
  return await Purchases.getCustomerInfo();
}

// Returns an EmitterSubscription — call .remove() on cleanup
export function addCustomerInfoListener(callback) {
  return Purchases.addCustomerInfoUpdateListener(callback);
}

// Presents the paywall only if the user lacks the Pro entitlement.
// Returns a PAYWALL_RESULT value.
export async function presentPaywall() {
  try {
    return await RevenueCatUI.presentPaywallIfNeeded({
      requiredEntitlementIdentifier: ENTITLEMENT_ID,
    });
  } catch (e) {
    logError(e, "presentPaywall");
    return PAYWALL_RESULT.ERROR;
  }
}

// Seat upgrades: the owner already holds the entitlement, so the
// "if needed" variant would refuse to show. Present unconditionally and let
// the store sheet handle the tier change + proration.
export async function presentPaywallForUpgrade() {
  try {
    return await RevenueCatUI.presentPaywall();
  } catch (e) {
    logError(e, "presentPaywallForUpgrade");
    return PAYWALL_RESULT.ERROR;
  }
}

export async function restorePurchases() {
  try {
    return await Purchases.restorePurchases();
  } catch (e) {
    logError(e, "restorePurchases");
    return null;
  }
}

export async function presentCustomerCenter() {
  try {
    await RevenueCatUI.presentCustomerCenter({
      callbacks: {
        onRestoreCompleted: ({ customerInfo }) => {
          // customerInfo update is broadcast via the listener in _layout.jsx —
          // no extra action needed here.
        },
        onRestoreFailed: ({ error }) => {
          logError(error, "customerCenter.onRestoreFailed");
        },
        onRefundRequestStarted: ({ productIdentifier }) => {},
        onRefundRequestCompleted: ({ productIdentifier, refundRequestStatus }) => {},
      },
    });
  } catch (e) {
    logError(e, "presentCustomerCenter");
  }
}

// Seat products encode the seat count: zanbi_pro_seats_1, _2, ... (mirrors the
// server-side seatsFromProductId in supabase/functions/_shared/rcSync.ts).
function seatsFromProductId(id) {
  if (!id) return 0;
  const m = /seats?[_-]?(\d+)/i.exec(id);
  const n = m ? parseInt(m[1], 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// The current offering's seat packages, keyed by seat count.
async function seatPackages() {
  const offerings = await Purchases.getOfferings();
  const pkgs = offerings?.current?.availablePackages ?? [];
  const map = new Map();
  for (const p of pkgs) {
    const n = seatsFromProductId(p?.product?.identifier);
    if (n > 0) map.set(n, p);
  }
  return map;
}

// Buy (or product-change to) the exact seat tier. RevenueCat handles the
// StoreKit/Play upgrade + proration. Throws (with .userCancelled when the user
// backs out) so callers can distinguish a cancel from a real failure.
export async function purchaseSeatCount(target) {
  const map = await seatPackages();
  const pkg = map.get(target);
  if (!pkg) {
    throw new Error(`No plan for ${target} seat${target === 1 ? "" : "s"} is available right now.`);
  }
  return await Purchases.purchasePackage(pkg);
}

// Per-seat localized price ($19.99) read off the seats_1 package, for showing
// accurate totals in the approvals inbox. Returns null if unavailable.
export async function seatUnitPrice() {
  try {
    const one = (await seatPackages()).get(1);
    if (!one?.product) return null;
    return { price: one.product.price, priceString: one.product.priceString };
  } catch (e) {
    logError(e, "seatUnitPrice");
    return null;
  }
}

export { PAYWALL_RESULT };
