import { load } from "cheerio";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BatchCaptureView } from "../batch/batch-capture";
import {
  appendAcceptedPhotos,
  UploadDraftProvider,
} from "./upload-draft-context";
import { UploadForm } from "./upload-form";

vi.mock("next/link", () => ({
  default: ({ href, ...props }: React.ComponentProps<"a">) => (
    <a href={String(href)} {...props} />
  ),
}));

vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: new Proxy(
    {},
    {
      get: (_target, element: string) =>
        ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) =>
          React.createElement(element, props, children),
    },
  ),
}));

function renderSingleUpload() {
  return load(
    renderToStaticMarkup(
      <UploadDraftProvider initialCaptureId="00000000-0000-4000-8000-000000000159">
        <UploadForm action={async () => undefined} />
      </UploadDraftProvider>,
    ),
  );
}

describe("direct photo input actions", () => {
  it.each([
    ["single-item", renderSingleUpload],
    ["batch-item", () => load(renderToStaticMarkup(<BatchCaptureView />))],
  ])(
    "renders an accessible single-file rear-camera path and multi-file library path for %s",
    (prefix, render) => {
      const $ = render();
      const camera = $(`#${prefix}-camera-input`);
      const library = $(`#${prefix}-library-input`);

      expect(camera.attr("type")).toBe("file");
      expect(camera.attr("accept")).toBe("image/png,image/jpeg,image/webp");
      expect(camera.attr("capture")).toBe("environment");
      expect(camera.attr("multiple")).toBeUndefined();
      expect(camera.attr("aria-hidden")).toBe("true");
      expect(
        $(`button[aria-controls="${prefix}-camera-input"]`).text(),
      ).toMatch(/take photo/i);

      expect(library.attr("type")).toBe("file");
      expect(library.attr("accept")).toBe("image/png,image/jpeg,image/webp");
      expect(library.attr("capture")).toBeUndefined();
      expect(library.is("[multiple]")).toBe(true);
      expect(library.attr("aria-hidden")).toBe("true");
      expect(
        $(`button[aria-controls="${prefix}-library-input"]`).text(),
      ).toMatch(/choose photos/i);
    },
  );
});

describe("shared accepted-photo append behavior", () => {
  const photo = (name: string, type = "image/jpeg") =>
    new File([name], name, { type });

  it("appends successive single camera captures until the four-photo cap", () => {
    const first = appendAcceptedPhotos([], [photo("front.jpg")]);
    const second = appendAcceptedPhotos(first.files, [photo("back.jpg")]);
    const third = appendAcceptedPhotos(second.files, [photo("label.jpg")]);
    const fourth = appendAcceptedPhotos(third.files, [photo("damage.jpg")]);
    const capped = appendAcceptedPhotos(fourth.files, [photo("extra.jpg")]);

    expect(fourth.files.map((file) => file.name)).toEqual([
      "front.jpg",
      "back.jpg",
      "label.jpg",
      "damage.jpg",
    ]);
    expect(capped.files).toEqual(fourth.files);
    expect(capped.overflowCount).toBe(1);
  });

  it("caps a multi-select library append and rejects unsupported types", () => {
    const result = appendAcceptedPhotos(
      [photo("cover.jpg")],
      [
        photo("side.png", "image/png"),
        photo("notes.txt", "text/plain"),
        photo("back.webp", "image/webp"),
        photo("detail.jpg"),
        photo("extra.jpg"),
      ],
    );

    expect(result.files.map((file) => file.name)).toEqual([
      "cover.jpg",
      "side.png",
      "back.webp",
      "detail.jpg",
    ]);
    expect(result.rejectedCount).toBe(1);
    expect(result.overflowCount).toBe(1);
  });

  it("treats a canceled picker as a no-op", () => {
    const existing = [photo("cover.jpg")];

    expect(appendAcceptedPhotos(existing, []).files).toEqual(existing);
  });
});

describe("single upload retry identity", () => {
  it("uses the capture key owned by the persistent upload draft provider", () => {
    const $ = renderSingleUpload();

    expect($('input[name="batchId"]').attr("value")).toBe(
      "00000000-0000-4000-8000-000000000159",
    );
    expect($('input[name="idempotencyKey"]').attr("value")).toBe(
      "single:00000000-0000-4000-8000-000000000159",
    );
  });
});
