import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ enqueueUpload: vi.fn() }));

vi.mock("./durable-actions", () => ({ enqueueUpload: mocks.enqueueUpload }));

import { uploadAndProcess } from "./actions";

describe("uploadAndProcess compatibility alias", () => {
  it("delegates every old single-item action to durable credit-backed staging", async () => {
    const formData = new FormData();
    mocks.enqueueUpload.mockResolvedValue(undefined);

    await expect(uploadAndProcess(formData)).resolves.toBeUndefined();
    expect(mocks.enqueueUpload).toHaveBeenCalledWith(formData);
  });
});
