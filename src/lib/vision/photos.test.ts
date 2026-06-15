import { describe, expect, it, vi } from "vitest";
import {
  PHOTOS_BUCKET,
  resolvePhotoImages,
  resolvePhotoImageData,
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
