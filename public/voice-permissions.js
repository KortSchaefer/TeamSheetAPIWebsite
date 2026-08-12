const defaultDevice = () => globalThis.navigator || {};

export const isIOSDevice = (device = defaultDevice()) =>
  /iPad|iPhone|iPod/.test(device.userAgent || "") ||
  (device.platform === "MacIntel" && Number(device.maxTouchPoints || 0) > 1);

export const microphoneConstraints = (device = defaultDevice()) =>
  isIOSDevice(device)
    ? true
    : { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

export const microphoneGuidance = (
  error,
  { secureContext = globalThis.isSecureContext === true, device = defaultDevice() } = {},
) => {
  const name = String(error?.name || "");
  const message = String(error?.message || error || "");
  const denied =
    name === "NotAllowedError" ||
    name === "SecurityError" ||
    /not allowed|denied permission|permission denied/i.test(message);

  if (denied && isIOSDevice(device)) {
    return {
      title: "Microphone access is blocked",
      summary:
        "Your iPhone or browser denied microphone access. This permission belongs to the phone and browser, not your employee account.",
      chip: "Microphone blocked",
      steps: [
        "Open iPhone Settings, choose Apps, choose your browser, and turn Microphone on.",
        "Also check Settings > Privacy & Security > Microphone and allow that browser.",
        "Return here, reload the page, and tap Try microphone again. If it is still blocked, open this same HTTPS page in Safari and allow Microphone in Website Settings.",
      ],
    };
  }
  if (denied) {
    return {
      title: "Microphone access is blocked",
      summary: "The browser or operating system denied microphone access for this site.",
      chip: "Microphone blocked",
      steps: [
        "Open the site controls beside the address bar and set Microphone to Allow.",
        "Check the device privacy settings and allow microphone access for this browser.",
        "Reload this page, then tap Try microphone again.",
      ],
    };
  }
  if (name === "NotFoundError") {
    return {
      title: "No microphone was found",
      summary: "The browser could not find a microphone or connected headset.",
      chip: "No microphone found",
      steps: [
        "Reconnect your AirPods or headset and confirm it appears as an audio input.",
        "Close and reopen the browser, then try again.",
        "You can use typed entry until a microphone is available.",
      ],
    };
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return {
      title: "The microphone is busy",
      summary:
        "Another app or browser tab may be using the microphone, or the phone could not start it.",
      chip: "Microphone busy",
      steps: [
        "Close calls, recording apps, and other tabs using the microphone.",
        "Reconnect your headset if you are using one.",
        "Return here and tap Try microphone again.",
      ],
    };
  }
  if (!secureContext) {
    return {
      title: "HTTPS is required",
      summary: "Phones only allow microphone capture on a secure HTTPS page.",
      chip: "HTTPS required",
      steps: [
        "Open the secure Cloudflare URL that begins with https://.",
        "Sign in again, then tap Start counting.",
      ],
    };
  }
  return {
    title: "The microphone could not start",
    summary:
      "The browser could not open the microphone. Try the steps below or continue with typed entry.",
    chip: "Microphone unavailable",
    steps: [
      "Confirm microphone access is enabled for this browser.",
      "Reload the page and reconnect your headset.",
      "If the problem continues, open the same page in Safari or Chrome.",
    ],
  };
};
