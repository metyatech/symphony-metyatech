import { describe, expect, it } from "vitest";
import { isSecretEnvName, redactSecrets, sanitizedProcessEnv } from "./process-safety.js";

describe("process safety", () => {
  it("removes secret-like environment variables", () => {
    const env = sanitizedProcessEnv({ PATH: "x", LINEAR_API_KEY: "lin_api_secret", NORMAL: "ok" });

    expect(env.PATH).toBe("x");
    expect(env.NORMAL).toBe("ok");
    expect(env.LINEAR_API_KEY).toBeUndefined();
    expect(isSecretEnvName("MY_TOKEN")).toBe(true);
  });

  it("redacts secret-like output values", () => {
    expect(redactSecrets("token lin_api_secret and Bearer abc.def")).toBe(
      "token [REDACTED] and [REDACTED]"
    );
  });
});
