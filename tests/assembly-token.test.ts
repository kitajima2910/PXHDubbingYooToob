import type { VercelRequest, VercelResponse } from "@vercel/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import assemblyToken from "../src/api/assemblyai/token";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ASSEMBLYAI_API_KEY;
});

describe("AssemblyAI temporary token", () => {
  it("chỉ trả token tạm thời từ backend", async () => {
    process.env.ASSEMBLYAI_API_KEY = "server-secret";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ token: "temporary-token", expires_in_seconds: 60 }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    let statusCode = 0;
    let body: unknown;
    const response = {
      setHeader: vi.fn(), end: vi.fn(),
      status(code: number) { statusCode = code; return this; },
      json(value: unknown) { body = value; return this; },
    } as unknown as VercelResponse;
    const request = {
      method: "POST", headers: {}, socket: { remoteAddress: "127.0.0.1" }, body: {},
    } as unknown as VercelRequest;

    await assemblyToken(request, response);

    expect(statusCode).toBe(200);
    expect(body).toEqual({ token: "temporary-token", expiresInSeconds: 60 });
    expect(fetchMock).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ headers: { authorization: "server-secret" } }));
  });
});
