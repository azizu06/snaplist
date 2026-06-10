import { describe, expect, it, vi } from "vitest";
import {
  PHOTOS_BUCKET,
  resolvePhotoImages,
  type SignedUrlClient,
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
