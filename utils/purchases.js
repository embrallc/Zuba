import { Platform } from "react-native";
import Purchases, { LOG_LEVEL } from "react-native-purchases";
import RevenueCatUI, { PAYWALL_RESULT } from "react-native-purchases-ui";
import { logError } from "../db/logs";

// Test key — replace with separate iOS/Android production keys before shipping
const API_KEY_IOS = "test_qiUnPrUuAJAugaWbUOnLjyDOxwL";
const API_KEY_ANDROID = "test_qiUnPrUuAJAugaWbUOnLjyDOxwL";

export const ENTITLEMENT_ID = "Embra LLC Pro";

export function configurePurchases() {
  Purchases.setLogLevel(__DEV__ ? LOG_LEVEL.VERBOSE : LOG_LEVEL.ERROR);
  const apiKey = Platform.OS === "ios" ? API_KEY_IOS : API_KEY_ANDROID;
  Purchases.configure({ apiKey });
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
