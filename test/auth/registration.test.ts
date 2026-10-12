import { describe, expect, test } from "bun:test";
import { withInferredApplicationType } from "../../src/lib/server/auth/registration";

const base = {
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
};

describe("withInferredApplicationType", () => {
  test("marks loopback-only public clients as native", () => {
    for (const uri of ["http://localhost:33418/callback", "http://127.0.0.1:5000/cb", "http://[::1]:8080/cb"]) {
      expect(withInferredApplicationType({ ...base, redirect_uris: [uri] })?.application_type).toBe("native");
    }
  });

  test("leaves https, confidential, explicit and non-loopback clients untouched", () => {
    expect(withInferredApplicationType({ ...base, redirect_uris: ["https://app.example.com/cb"] })).toBeNull();
    expect(withInferredApplicationType({ ...base, redirect_uris: ["http://example.com/cb"] })).toBeNull();
    expect(
      withInferredApplicationType({ ...base, token_endpoint_auth_method: "client_secret_basic", redirect_uris: ["http://localhost/cb"] }),
    ).toBeNull();
    expect(withInferredApplicationType({ ...base, application_type: "web", redirect_uris: ["http://localhost/cb"] })).toBeNull();
    expect(withInferredApplicationType({ ...base, redirect_uris: [] })).toBeNull();
    expect(withInferredApplicationType(null)).toBeNull();
  });
});
