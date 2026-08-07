import { describe, expect, it, vi } from "vitest";
import { runAdaptiveBatch } from "../src/extension/training/adaptive-batch";

describe("adaptive training batch", () => {
  it("giữ nguyên batch khi provider thành công", async () => {
    const process = vi.fn(async (items: number[]) => items.map((item) => item * 2));
    await expect(runAdaptiveBatch([1, 2, 3], process)).resolves.toEqual([2, 4, 6]);
    expect(process).toHaveBeenCalledTimes(1);
  });

  it("tự chia nhỏ batch lỗi và giữ thứ tự kết quả", async () => {
    const process = vi.fn(async (items: number[]) => {
      if (items.length > 2) throw new Error("batch quá lớn");
      return items.map((item) => item * 2);
    });
    await expect(runAdaptiveBatch([1, 2, 3, 4, 5], process)).resolves.toEqual([2, 4, 6, 8, 10]);
    expect(process.mock.calls.some(([items]) => items.length <= 2)).toBe(true);
  });

  it("trả lỗi thật khi một câu đơn vẫn thất bại", async () => {
    await expect(runAdaptiveBatch([1, 2], async (items) => {
      if (items.includes(2)) throw new Error("câu lỗi");
      return items;
    })).rejects.toThrow("câu lỗi");
  });
});
