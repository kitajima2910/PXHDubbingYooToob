/**
 * Cache audio MP3 bằng IndexedDB — content script standalone (không chunk riêng).
 * Các hàm hash/key là thuần (test được trong node, không phụ thuộc IndexedDB/crypto.subtle).
 * Mọi lỗi IndexedDB đều được catch và trả về fallback luồng TTS gốc — không bao giờ
 * làm hỏng việc tạo giọng nói.
 */

const DB_NAME = "pxh-dubbing-audio";
const DB_VERSION = 1;
const STORE_NAME = "blobs";

interface CachedAudioRecord { key: string; blob: Blob }

/**
 * FNV-1a 64-bit thuần — dùng 4 limb 16-bit để tránh mất precision của number.
 * Trả về hex 16 ký tự (2^64). Không dùng crypto.subtle nên chạy được trong node.
 */
export function hashString(text: string): string {
  // offset basis FNV-1a 64-bit: 0xcbf29ce484222325 (chia 4 limb 16-bit)
  let h3 = 0xcbf2; // hi
  let h2 = 0x9ce4;
  let h1 = 0x8422;
  let h0 = 0x2325; // lo
  // prime FNV-1a 64-bit: 0x100000001b3 = 0x100 * 2^32 + 0x1b3
  const p2 = 0x100;
  const p0 = 0x1b3;
  for (let index = 0; index < text.length; index += 1) {
    h0 ^= text.charCodeAt(index) & 0xff;
    // Nhân 64-bit theo schoolbook trên limb 16-bit (kết quả < 2^53 an toàn).
    const a0 = h0, a1 = h1, a2 = h2, a3 = h3;
    let r0 = a0 * p0;
    let r1 = a1 * p0 + a0 * p2;
    let r2 = a2 * p0 + a1 * p2;
    let r3 = a3 * p0 + a2 * p2;
    // Carry propagation (bỏ carry vượt 64-bit = mod 2^64).
    let carry = Math.floor(r0 / 0x10000);
    h0 = r0 % 0x10000;
    r1 += carry;
    carry = Math.floor(r1 / 0x10000);
    h1 = r1 % 0x10000;
    r2 += carry;
    carry = Math.floor(r2 / 0x10000);
    h2 = r2 % 0x10000;
    r3 += carry;
    h3 = r3 % 0x10000;
  }
  const toHex = (limb: number): string => limb.toString(16).padStart(4, "0");
  return toHex(h3) + toHex(h2) + toHex(h1) + toHex(h0);
}

/** Key cache ổn định theo text + voice + rate — dùng cho /api/tts. */
export function audioCacheKey(text: string, voice: string, rate: number): string {
  return `tts:${hashString(`${voice}|${rate}|${text}`)}`;
}

function openAudioDb(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB không khả dụng"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (): void => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void => reject(request.error ?? new Error("Không mở được IndexedDB"));
  });
}

/**
 * Lấy blob audio đã cache. Mọi lỗi (không mở được DB, record thiếu, lỗi transaction)
 * đều bị nuốt → trả undefined để gọi TTS gốc.
 */
export async function getCachedAudio(key: string): Promise<Blob | undefined> {
  let db: IDBDatabase | undefined;
  try {
    db = await openAudioDb();
    return await new Promise<Blob | undefined>((resolve, reject) => {
      const transaction = db!.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(key) as IDBRequest<CachedAudioRecord | undefined>;
      request.onsuccess = (): void => resolve(request.result?.blob);
      request.onerror = (): void => reject(request.error);
    });
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

/** Lưu blob audio vào cache. Mọi lỗi đều nuốt — không ảnh hưởng luồng TTS. */
export async function setCachedAudio(key: string, blob: Blob): Promise<void> {
  let db: IDBDatabase | undefined;
  try {
    db = await openAudioDb();
    await new Promise<void>((resolve, reject) => {
      const transaction = db!.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put({ key, blob } satisfies CachedAudioRecord);
      transaction.oncomplete = (): void => resolve();
      transaction.onerror = (): void => reject(transaction.error);
      transaction.onabort = (): void => reject(transaction.error);
    });
    pruneCounter += 1;
    if (pruneCounter % 25 === 0) void pruneAudioCache();
  } catch {
    /* Cache phụ trợ — lỗi IndexedDB không được làm hỏng TTS. */
  } finally {
    db?.close();
  }
}

let pruneCounter = 0;

/**
 * Khi store vượt ngưỡng, xóa record cũ qua cursor (lệnh này không hủy TTS nếu lỗi).
 * Được gọi định kỳ từ setCachedAudio để tránh phình vô hạn.
 */
export async function pruneAudioCache(limit = 2000): Promise<void> {
  let db: IDBDatabase | undefined;
  try {
    db = await openAudioDb();
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const count = await new Promise<number>((resolve, reject) => {
      const request = store.count();
      request.onsuccess = (): void => resolve(request.result);
      request.onerror = (): void => reject(request.error);
    });
    if (count <= limit) return;
    const excess = count - limit;
    let deleted = 0;
    await new Promise<void>((resolve, reject) => {
      const cursorRequest = store.openCursor();
      cursorRequest.onsuccess = (): void => {
        const cursor = cursorRequest.result;
        if (!cursor || deleted >= excess) { resolve(); return; }
        cursor.delete();
        deleted += 1;
        cursor.continue();
      };
      cursorRequest.onerror = (): void => reject(cursorRequest.error);
    });
  } catch {
    /* Bỏ qua — prune chỉ là dọn dẹp nền. */
  } finally {
    db?.close();
  }
}
