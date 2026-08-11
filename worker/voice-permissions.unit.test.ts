import { describe, expect, it } from "vitest";

// The browser helper is shipped directly as a static ES module.
// @ts-expect-error JavaScript static assets intentionally have no TypeScript declaration file.
import { microphoneConstraints, microphoneGuidance } from "../public/voice-permissions.js";

const iphone = {
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
  platform: "iPhone",
  maxTouchPoints: 5,
};

describe("voice inventory microphone guidance", () => {
  it("uses minimal constraints and actionable iPhone steps after permission denial", () => {
    expect(microphoneConstraints(iphone)).toBe(true);

    const guidance = microphoneGuidance(
      { name: "NotAllowedError", message: "The request is not allowed by the user agent" },
      { secureContext: true, device: iphone },
    );

    expect(guidance.title).toBe("Microphone access is blocked");
    expect(guidance.summary).toContain("not your employee account");
    expect(guidance.steps.join(" ")).toContain("iPhone Settings");
    expect(guidance.steps.join(" ")).toContain("Safari");
  });

  it("distinguishes missing, busy, and insecure microphone failures", () => {
    const desktop = { userAgent: "Desktop", platform: "Win32", maxTouchPoints: 0 };

    expect(
      microphoneGuidance({ name: "NotFoundError" }, { secureContext: true, device: desktop }).title,
    ).toBe("No microphone was found");
    expect(
      microphoneGuidance({ name: "NotReadableError" }, { secureContext: true, device: desktop })
        .title,
    ).toBe("The microphone is busy");
    expect(
      microphoneGuidance(new Error("unsupported"), { secureContext: false, device: desktop }).title,
    ).toBe("HTTPS is required");
  });
});
