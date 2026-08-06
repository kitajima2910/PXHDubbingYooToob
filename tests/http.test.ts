import { describe, expect, it, vi } from "vitest";
import { retry } from "../src/api/lib/http";

describe("retry", () => {
  it("thử lại lỗi tạm thời", async () => {
    const operation = vi.fn().mockRejectedValueOnce(new Error("tạm thời")).mockResolvedValue("ổn");
    await expect(retry(operation, 2)).resolves.toBe("ổn");
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
