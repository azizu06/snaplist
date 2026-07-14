import { describe, expect, it } from "vitest";
import {
  MAX_MESSAGE_PHOTO_BYTES,
  MAX_MESSAGE_PHOTOS,
  normalizeInboundMessagePhoto,
  validateMessagePhotoBatch,
  validateStoredMessagePhotoPath,
} from "./attachments";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50,
]);

describe("message photo policy", () => {
  it("accepts the deliberately supported JPEG, PNG, and WebP subset", () => {
    const result = validateMessagePhotoBatch([
      { name: "front.jpg", type: "image/jpeg", size: JPEG.length, bytes: JPEG },
      { name: "label.png", type: "image/png", size: PNG.length, bytes: PNG },
      { name: "detail.webp", type: "image/webp", size: WEBP.length, bytes: WEBP },
    ]);

    expect(result.map((photo) => photo.mediaType)).toEqual([
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
  });

  it("rejects documents, SVG, MIME spoofing, oversize files, and excess count", () => {
    expect(() =>
      validateMessagePhotoBatch([
        { name: "manual.pdf", type: "application/pdf", size: 4, bytes: PNG },
      ]),
    ).toThrow(/JPEG, PNG, or WebP/i);
    expect(() =>
      validateMessagePhotoBatch([
        {
          name: "vector.svg",
          type: "image/svg+xml",
          size: 11,
          bytes: new TextEncoder().encode("<svg></svg>"),
        },
      ]),
    ).toThrow(/JPEG, PNG, or WebP/i);
    expect(() =>
      validateMessagePhotoBatch([
        { name: "spoof.jpg", type: "image/jpeg", size: PNG.length, bytes: PNG },
      ]),
    ).toThrow(/content does not match/i);
    expect(() =>
      validateMessagePhotoBatch([
        {
          name: "huge.jpg",
          type: "image/jpeg",
          size: MAX_MESSAGE_PHOTO_BYTES + 1,
          bytes: JPEG,
        },
      ]),
    ).toThrow(/12 MB/i);
    expect(() =>
      validateMessagePhotoBatch(
        Array.from({ length: MAX_MESSAGE_PHOTOS + 1 }, (_, index) => ({
          name: `${index}.jpg`,
          type: "image/jpeg",
          size: JPEG.length,
          bytes: JPEG,
        })),
      ),
    ).toThrow(/up to 5 photos/i);
  });

  it("normalizes only safe HTTPS eBay image media for inbound rendering", () => {
    expect(
      normalizeInboundMessagePhoto({
        mediaName: "buyer-photo.jpg",
        mediaType: "IMAGE",
        mediaUrl: "https://i.ebayimg.com/images/g/example/s-l1600.jpg",
      }),
    ).toEqual({
      name: "buyer-photo.jpg",
      providerUrl: "https://i.ebayimg.com/images/g/example/s-l1600.jpg",
      providerMediaType: "IMAGE",
    });
    expect(
      normalizeInboundMessagePhoto({
        mediaName: "invoice.pdf",
        mediaType: "PDF",
        mediaUrl: "https://i.ebayimg.com/invoice.pdf",
      }),
    ).toBeNull();
    expect(() =>
      normalizeInboundMessagePhoto({
        mediaName: "tracking.png",
        mediaType: "IMAGE",
        mediaUrl: "https://attacker.example/tracking.png",
      }),
    ).toThrow(/trusted eBay image host/i);
    expect(() =>
      normalizeInboundMessagePhoto({
        mediaName: "plain-http.jpg",
        mediaType: "IMAGE",
        mediaUrl: "http://i.ebayimg.com/image.jpg",
      }),
    ).toThrow(/HTTPS/i);
  });

  it("binds direct uploads to the owning tenant and conversation", () => {
    const photo = {
      name: "condition.jpg",
      mediaType: "image/jpeg" as const,
      byteSize: JPEG.length,
      storagePath:
        "user_a/11111111-1111-4111-8111-111111111111/pending/22222222-2222-4222-8222-222222222222.jpg",
    };
    expect(() => validateStoredMessagePhotoPath({
      userId: "user_a",
      conversationRootId: "11111111-1111-4111-8111-111111111111",
      photo,
    })).not.toThrow();
    expect(() => validateStoredMessagePhotoPath({
      userId: "user_b",
      conversationRootId: "11111111-1111-4111-8111-111111111111",
      photo,
    })).toThrow(/does not belong/i);
    expect(() => validateStoredMessagePhotoPath({
      userId: "user_a",
      conversationRootId: "11111111-1111-4111-8111-111111111111",
      photo: { ...photo, storagePath: photo.storagePath.replace(/\.jpg$/, ".png") },
    })).toThrow(/does not belong/i);
  });
});
