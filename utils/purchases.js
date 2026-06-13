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

export { PAYWALL_RESULT };
