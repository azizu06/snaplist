import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SIGNED_URL_TTL_SECONDS,
  PHOTOS_BUCKET,
  resolvePhotoImages,
  resolvePhotoImageData,
  batchSignPhotoUrls,
  signPhotoUrlMap,
  type BatchSignedUrlClient,
  type SignedUrlClient,
  type DownloadClient,
} from "./photos";

/**
 * `resolvePhotoImages` unit tests with a FAKE storage client (offline). Asserts it
 * signs the right bucket+paths in order and surfaces a clear error on failure.
 */

function fakeClient(
  impl: (path: string, expiresIn: number) => {
    data: { signedUrl: string } | null;
    error: { message: string } | null;
  },
): { client: SignedUrlClient; from: ReturnType<typeof vi.fn>; createSignedUrl: ReturnType<typeof vi.fn> } {
  const createSignedUrl = vi.fn(async (path: string, expiresIn: number) =>
    impl(path, expiresIn),
  );
  const from = vi.fn((bucket: string) => {
    void bucket;
    return { createSignedUrl };
  });
  return { client: { storage: { from } }, from, createSignedUrl };
}

describe("vision/photos — resolvePhotoImages", () => {
  it("signs each path against the private photos bucket, in order", async () => {
    const { client, from, createSignedUrl } = fakeClient((path) => ({
      data: { signedUrl: `https://signed.example/${path}?token=abc` },
      error: null,
    }));

    const urls = await resolvePhotoImages(client, [
      "user-1/a.jpg",
      "user-1/b.jpg",
    ]);

    expect(from).toHaveBeenCalledWith(PHOTOS_BUCKET);
    expect(createSignedUrl).toHaveBeenCalledTimes(2);
    expect(urls).toEqual([
      "https://signed.example/user-1/a.jpg?token=abc",
      "https://signed.example/user-1/b.jpg?token=abc",
    ]);
  });

  it("passes the configured TTL through to createSignedUrl", async () => {
    const { client, createSignedUrl } = fakeClient((path) => ({
      data: { signedUrl: `https://s/${path}` },
      error: null,
    }));
    await resolvePhotoImages(client, ["u/x.png"], { expiresIn: 42 });
    expect(createSignedUrl).toHaveBeenCalledWith("u/x.png", 42);
  });

  it("throws a clear error when a path cannot be signed", async () => {
    const { client } = fakeClient(() => ({
      data: null,
      error: { message: "Object not found" },
    }));
    await expect(
      resolvePhotoImages(client, ["u/missing.jpg"]),
    ).rejects.toThrow(/missing\.jpg.*Object not found/);
  });

  it("returns an empty array for no paths", async () => {
    const { client, createSignedUrl } = fakeClient((path) => ({
      data: { signedUrl: `https://s/${path}` },
      error: null,
    }));
    await expect(resolvePhotoImages(client, [])).resolves.toEqual([]);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });
});

/**
 * `resolvePhotoImageData` unit tests (offline) — the byte-download path the real
 * pipeline uses. Inlining bytes (vs a signed URL) is what lets local dev work: the AI
 * SDK rejects private/loopback Storage URLs (`127.0.0.1`) when a remote-URL-incapable
 * provider (Gemini) forces a server-side download.
 */
function fakeDownloader(
  impl: (path: string) => { data: Blob | null; error: { message: string } | null },
): { client: DownloadClient; from: ReturnType<typeof vi.fn>; download: ReturnType<typeof vi.fn> } {
  const download = vi.fn(async (path: string) => impl(path));
  const from = vi.fn((bucket: string) => {
    void bucket;
    return { download };
  });
  return { client: { storage: { from } }, from, download };
}

function fakeBatchClient(
  impl: (paths: string[], expiresIn: number) => {
    data: Array<{ path: string | null; signedUrl: string | null }> | null;
    error: { message: string } | null;
  },
): { client: BatchSignedUrlClient; from: ReturnType<typeof vi.fn>; createSignedUrls: ReturnType<typeof vi.fn> } {
  const createSignedUrls = vi.fn(async (paths: string[], expiresIn: number) =>
    impl(paths, expiresIn),
  );
  const from = vi.fn((bucket: string) => {
    void bucket;
    return { createSignedUrls };
  });
  return { client: { storage: { from } }, from, createSignedUrls };
}

describe("vision/photos — signPhotoUrlMap (best-effort UI signing)", () => {
  it("batch-signs all paths in ONE storage call and maps path → signed url", async () => {
    const { client, from, createSignedUrls } = fakeBatchClient((paths) => ({
      data: paths.map((p) => ({ path: p, signedUrl: `https://signed/${p}` })),
      error: null,
    }));
    const map = await signPhotoUrlMap(client, ["u1/a.jpg", "u1/b.jpg"]);
    expect(from).toHaveBeenCalledWith(PHOTOS_BUCKET);
    expect(createSignedUrls).toHaveBeenCalledTimes(1);
    expect(createSignedUrls).toHaveBeenCalledWith(
      ["u1/a.jpg", "u1/b.jpg"],
      DEFAULT_SIGNED_URL_TTL_SECONDS,
    );
    expect(map.get("u1/a.jpg")).toBe("https://signed/u1/a.jpg");
    expect(map.get("u1/b.jpg")).toBe("https://signed/u1/b.jpg");
  });

  it("DROPS unsignable paths instead of failing (missing thumb ≠ broken page)", async () => {
    const { client } = fakeBatchClient((paths) => ({
      data: paths.map((p) =>
        p.endsWith("bad.jpg")
          ? { path: p, signedUrl: null }
          : { path: p, signedUrl: `https://signed/${p}` },
      ),
      error: null,
    }));
    const map = await signPhotoUrlMap(client, ["u1/a.jpg", "u1/bad.jpg"]);
    expect(map.get("u1/a.jpg")).toBe("https://signed/u1/a.jpg");
    expect(map.has("u1/bad.jpg")).toBe(false);
  });

  it("returns an empty map on a batch error (best-effort, never throws)", async () => {
    const { client } = fakeBatchClient(() => ({
      data: null,
      error: { message: "storage down" },
    }));
    const map = await signPhotoUrlMap(client, ["u1/a.jpg"]);
    expect(map.size).toBe(0);
  });

  it("skips the storage call entirely for no paths", async () => {
    const { client, createSignedUrls } = fakeBatchClient(() => ({ data: [], error: null }));
    const map = await signPhotoUrlMap(client, []);
    expect(map.size).toBe(0);
    expect(createSignedUrls).not.toHaveBeenCalled();
  });

  it("passes a custom TTL through", async () => {
    const { client, createSignedUrls } = fakeBatchClient((paths) => ({
      data: paths.map((p) => ({ path: p, signedUrl: `https://signed/${p}` })),
      error: null,
    }));
    await signPhotoUrlMap(client, ["u1/a.jpg"], { expiresIn: 30 });
    expect(createSignedUrls).toHaveBeenCalledWith(["u1/a.jpg"], 30);
  });
});

describe("vision/photos — batchSignPhotoUrls (strict-transport signing)", () => {
  it("THROWS on a batch/transport error so publish can't mistake an outage for missing photos", async () => {
    const { client } = fakeBatchClient(() => ({
      data: null,
      error: { message: "storage down" },
    }));
    await expect(batchSignPhotoUrls(client, ["u1/a.jpg"])).rejects.toThrow(/storage down/);
  });

  it("still drops PER-ENTRY failures without throwing (a missing photo isn't an outage)", async () => {
    const { client } = fakeBatchClient((paths) => ({
      data: paths.map((p) =>
        p.endsWith("bad.jpg")
          ? { path: p, signedUrl: null }
          : { path: p, signedUrl: `https://signed/${p}` },
      ),
      error: null,
    }));
    const map = await batchSignPhotoUrls(client, ["u1/a.jpg", "u1/bad.jpg"]);
    expect(map.get("u1/a.jpg")).toBe("https://signed/u1/a.jpg");
    expect(map.has("u1/bad.jpg")).toBe(false);
  });
});

describe("vision/photos — resolvePhotoImageData", () => {
  it("downloads each path against the private photos bucket, in order, as inline bytes", async () => {
    const { client, from, download } = fakeDownloader(() => ({
      data: new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }),
      error: null,
    }));

    const images = await resolvePhotoImageData(client, [
      "user-1/a.jpg",
      "user-1/b.png",
    ]);

    expect(from).toHaveBeenCalledWith(PHOTOS_BUCKET);
    expect(download.mock.calls.map((c) => c[0])).toEqual([
      "user-1/a.jpg",
      "user-1/b.png",
    ]);
    expect(images).toEqual([
      { data: new Uint8Array([1, 2, 3]), mediaType: "image/jpeg" },
      { data: new Uint8Array([1, 2, 3]), mediaType: "image/jpeg" },
    ]);
  });

  it("falls back to the path extension when the download carries no Content-Type", async () => {
    const blankType = () => ({
      data: new Blob([new Uint8Array([9])], { type: "" }),
      error: null,
    });
    const { client } = fakeDownloader(blankType);
    const [png] = await resolvePhotoImageData(client, ["u/x.png"]);
    expect(png.mediaType).toBe("image/png");
    const [webp] = await resolvePhotoImageData(client, ["u/y.webp"]);
    expect(webp.mediaType).toBe("image/webp");
    const [jpg] = await resolvePhotoImageData(client, ["u/z.JPG"]);
    expect(jpg.mediaType).toBe("image/jpeg");
  });

  it("throws a clear error when a path cannot be downloaded", async () => {
    const { client } = fakeDownloader(() => ({
      data: null,
      error: { message: "Object not found" },
    }));
    await expect(
      resolvePhotoImageData(client, ["u/missing.jpg"]),
    ).rejects.toThrow(/missing\.jpg.*Object not found/);
  });

  it("returns an empty array for no paths (no download calls)", async () => {
    const { client, download } = fakeDownloader(() => ({
      data: new Blob([new Uint8Array([1])], { type: "image/jpeg" }),
      error: null,
    }));
    await expect(resolvePhotoImageData(client, [])).resolves.toEqual([]);
    expect(download).not.toHaveBeenCalled();
  });
});
