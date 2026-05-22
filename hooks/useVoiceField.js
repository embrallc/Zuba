import { useCallback, useEffect, useRef } from "react";
import { useVoiceStore } from "../stores/useVoiceStore";

// Wire a controlled TextInput into the voice-dictation system. Returns an
// `onFocus` handler the input should call (the input may have its own focus
// logic; combine them with a wrapper). When the input unmounts (or this
// component does), the field is automatically cleared if it's the one
// currently registered.
//
// Usage:
//   const voice = useVoiceField(value, onChangeText);
//   <TextInput value={value} onChangeText={onChangeText} onFocus={voice.onFocus} />
export function useVoiceField(value, onChangeText) {
  const valueRef = useRef(value);
  valueRef.current = value;

  const onChangeTextRef = useRef(onChangeText);
  onChangeTextRef.current = onChangeText;

  // Stable identity for this field across re-renders. Used to clear ourselves
  // on unmount only if we're still the current target.
  const tokenRef = useRef(null);
  if (tokenRef.current === null) tokenRef.current = Symbol("voiceField");

  const setField = useVoiceStore((s) => s.setField);

  const onFocus = useCallback(() => {
    setField({
      token: tokenRef.current,
      getValue: () => valueRef.current ?? "",
      setValue: (v) => onChangeTextRef.current?.(v),
    });
  }, [setField]);

  useEffect(() => {
    const token = tokenRef.current;
    return () => {
      useVoiceStore.getState().clearFieldIfMatches(token);
    };
  }, []);

  return { onFocus };
}
