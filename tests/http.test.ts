import { describe, expect, it, vi } from "vitest";
import { prepare, retry } from "../src/api/lib/http";

function request(origin: string): Parameters<typeof prepare>[0] {
  return { method: "POST", headers: { origin, "content-length": "0" }, socket: {} } as Parameters<typeof prepare>[0];
}

function response(): Parameters<typeof prepare>[1] & { setHeader: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> } {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn(), end: vi.fn() };
  res.status.mockReturnValue(res);
  return res as unknown as ReturnType<typeof response>;
}

describe("prepare", () => {
  it("chấp nhận ID động của extension cài từ release", () => {
    vi.stubEnv("EXTENSION_ORIGIN", "chrome-extension://nifofpjnaneckgedepoamjchdfiejcbh");
    const res = response();

    expect(prepare(request("chrome-extension://abcdefghijklmnopabcdefghijklmnop"), res)).toBe(true);
    expect(res.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Origin", "chrome-extension://abcdefghijklmnopabcdefghijklmnop");
    vi.unstubAllEnvs();
  });

  it("vẫn từ chối origin web không được cấu hình", () => {
    vi.stubEnv("EXTENSION_ORIGIN", "chrome-extension://nifofpjnaneckgedepoamjchdfiejcbh");
    const res = response();

    expect(prepare(request("https://example.com"), res)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
    vi.unstubAllEnvs();
  });
});

describe("retry", () => {
  it("thử lại lỗi tạm thời", async () => {
    const operation = vi.fn().mockRejectedValueOnce(new Error("tạm thời")).mockResolvedValue("ổn");
    await expect(retry(operation, 2)).resolves.toBe("ổn");
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
