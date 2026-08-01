import { describe, expect, it, vi } from "vitest";
import { deleteClerkIdentity, deleteRevenueCatCustomer } from "./identity";

function clerkError(status: number) {
  return Object.assign(new Error(`clerk ${status}`), { status });
}

describe("Clerk identity deletion", () => {
  it("proves absence by reading the same id back as a reported 404", async () => {
    const client = {
      users: {
        deleteUser: vi.fn().mockResolvedValue(undefined),
        getUser: vi.fn().mockRejectedValue(clerkError(404)),
      },
    };

    await expect(deleteClerkIdentity(client, { clerkUserId: "user_384" }))
      .resolves.toEqual({ absent: true });
    expect(client.users.deleteUser).toHaveBeenCalledWith("user_384");
    expect(client.users.getUser).toHaveBeenCalledWith("user_384");
  });

  it("refuses to call a rejected read absence, because a 500 is not a 404", async () => {
    const client = {
      users: {
        deleteUser: vi.fn().mockResolvedValue(undefined),
        getUser: vi.fn().mockRejectedValue(clerkError(500)),
      },
    };

    await expect(deleteClerkIdentity(client, { clerkUserId: "user_384" }))
      .resolves.toEqual({ absent: false });
  });

  it("refuses to call a successful read absence", async () => {
    const client = {
      users: {
        deleteUser: vi.fn().mockResolvedValue(undefined),
        getUser: vi.fn().mockResolvedValue({ id: "user_384" }),
      },
    };

    await expect(deleteClerkIdentity(client, { clerkUserId: "user_384" }))
      .resolves.toEqual({ absent: false });
  });

  it("still proves absence when the user was already gone", async () => {
    const client = {
      users: {
        deleteUser: vi.fn().mockRejectedValue(clerkError(404)),
        getUser: vi.fn().mockRejectedValue(clerkError(404)),
      },
    };

    await expect(deleteClerkIdentity(client, { clerkUserId: "user_384" }))
      .resolves.toEqual({ absent: true });
  });

  it("does not read back when the delete itself failed", async () => {
    const client = {
      users: {
        deleteUser: vi.fn().mockRejectedValue(clerkError(503)),
        getUser: vi.fn(),
      },
    };

    await expect(deleteClerkIdentity(client, { clerkUserId: "user_384" }))
      .resolves.toEqual({ absent: false });
    expect(client.users.getUser).not.toHaveBeenCalled();
  });
});

describe("RevenueCat customer deletion", () => {
  const config = {
    secretKey: "sk_revenuecat",
    projectId: "proj_384",
    baseURL: "https://revenuecat.test",
  };

  function response(status: number) {
    return { status, ok: status >= 200 && status < 300 } as Response;
  }

  it("deletes through v1 and proves absence through v2, in that order", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(200))
      .mockResolvedValueOnce(response(200))
      .mockResolvedValueOnce(response(404));

    await expect(deleteRevenueCatCustomer(
      { ...config, fetch: fetchImpl as unknown as typeof globalThis.fetch },
      { appUserId: "rc_384" },
    )).resolves.toEqual({ absent: true });

    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      ["https://revenuecat.test/v2/projects/proj_384/customers/rc_384", "GET"],
      ["https://revenuecat.test/v1/subscribers/rc_384", "DELETE"],
      ["https://revenuecat.test/v2/projects/proj_384/customers/rc_384", "GET"],
    ]);
  });

  // The v1 GET creates the subscriber it is asked about, so using it as the
  // read-back would resurrect the record and then report it present.
  it("never reads a customer back through the v1 subscriber endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(404));

    await deleteRevenueCatCustomer(
      { ...config, fetch: fetchImpl as unknown as typeof globalThis.fetch },
      { appUserId: "rc_384" },
    );

    const v1Reads = fetchImpl.mock.calls.filter(
      ([url, init]) => String(url).includes("/v1/subscribers/") && init.method !== "DELETE",
    );
    expect(v1Reads).toEqual([]);
  });

  // A 404 also answers a project whose account lacks access to the gated v2
  // customer endpoints, so absence needs the customer to have been there first.
  it("will not read absence from a 404 it cannot distinguish", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(404))
      .mockResolvedValueOnce(response(200))
      .mockResolvedValueOnce(response(404));

    await expect(deleteRevenueCatCustomer(
      { ...config, fetch: fetchImpl as unknown as typeof globalThis.fetch },
      { appUserId: "rc_384" },
    )).resolves.toEqual({ absent: false });
  });

  it("reports unverified when no project id makes the read-back possible", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200));

    await expect(deleteRevenueCatCustomer(
      {
        secretKey: "sk_revenuecat",
        baseURL: "https://revenuecat.test",
        fetch: fetchImpl as unknown as typeof globalThis.fetch,
      },
      { appUserId: "rc_384" },
    )).resolves.toEqual({ absent: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports unverified when the customer survives the delete", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(200))
      .mockResolvedValueOnce(response(200))
      .mockResolvedValueOnce(response(200));

    await expect(deleteRevenueCatCustomer(
      { ...config, fetch: fetchImpl as unknown as typeof globalThis.fetch },
      { appUserId: "rc_384" },
    )).resolves.toEqual({ absent: false });
  });

  it("reports unverified when the delete itself was refused", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(200))
      .mockResolvedValueOnce(response(500));

    await expect(deleteRevenueCatCustomer(
      { ...config, fetch: fetchImpl as unknown as typeof globalThis.fetch },
      { appUserId: "rc_384" },
    )).resolves.toEqual({ absent: false });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
