import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { seedUser } from "./helpers";

describe("login rate limiting", () => {
  it("returns 429 after too many failed password attempts", async () => {
    await seedUser({ email: "owner@example.com", password: "correct-horse" });

    const attempt = () =>
      SELF.fetch("http://localhost/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.50",
        },
        body: JSON.stringify({ email: "owner@example.com", password: "wrong-password" }),
      });

    for (let i = 0; i < 10; i++) {
      const res = await attempt();
      expect(res.status).toBe(401);
      expect((await res.json<{ error: string }>()).error).toBe("invalid_credentials");
    }

    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect((await limited.json<{ error: string }>()).error).toBe("too_many_attempts");
  });

  it("clears limits after a successful login", async () => {
    await seedUser({ email: "ok@example.com", password: "correct-horse" });

    for (let i = 0; i < 5; i++) {
      const res = await SELF.fetch("http://localhost/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "198.51.100.9",
        },
        body: JSON.stringify({ email: "ok@example.com", password: "nope" }),
      });
      expect(res.status).toBe(401);
    }

    const ok = await SELF.fetch("http://localhost/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "198.51.100.9",
      },
      body: JSON.stringify({ email: "ok@example.com", password: "correct-horse" }),
    });
    expect(ok.status).toBe(200);

    for (let i = 0; i < 5; i++) {
      const res = await SELF.fetch("http://localhost/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "198.51.100.9",
        },
        body: JSON.stringify({ email: "ok@example.com", password: "nope" }),
      });
      expect(res.status).toBe(401);
    }
  });
});
