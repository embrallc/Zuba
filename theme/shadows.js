import { Platform } from "react-native";

const shadow = (ios, androidElevation) =>
  Platform.OS === "ios" ? ios : { elevation: androidElevation };

export const shadows = {
  light: shadow(
    {
      shadowColor: "#5C5CE8",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.07,
      shadowRadius: 8,
    },
    3,
  ),

  medium: shadow(
    {
      shadowColor: "#5C5CE8",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.13,
      shadowRadius: 16,
    },
    7,
  ),

  dark: shadow(
    {
      shadowColor: "#1E1B4B",
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.20,
      shadowRadius: 24,
    },
    16,
  ),
};
