import { describe, expect, it, vi } from "vitest";
import {
  createPostHogAccountErasureAnalytics,
  createPostHogPersonManagementClient,
} from "./posthog";

const personUUID = "61700000-0000-4000-8000-000000000001";

describe("PostHog account-erasure executor", () => {
  it("maps the current Persons API through a mocked HTTP boundary", async () => {
    const requests: Request[] = [];
    const responses = [
      new Response(JSON.stringify({
        count: 1,
        next: null,
        previous: null,
        results: [{
          id: 617,
          uuid: personUUID,
          distinct_ids: ["anonymous-617", "user_617"],
          name: "",
          properties: {},
          created_at: "2026-08-02T15:00:00.000Z",
          last_seen_at: "2026-08-02T15:30:00.000Z",
        }],
      }), { status: 200 }),
      new Response(JSON.stringify({
        persons_found: 1,
        persons_deleted: 1,
        events_queued_for_deletion: true,
        recordings_queued_for_deletion: false,
        deletion_errors: [],
      }), { status: 202 }),
      new Response(JSON.stringify({
        count: 1,
        next: null,
        previous: null,
        results: [{
          person_uuid: personUUID,
          created_at: "2026-08-02T15:31:00.000Z",
          status: "completed",
          delete_verified_at: "2026-08-02T16:00:00.000Z",
        }],
      }), { status: 200 }),
      new Response(null, { status: 404 }),
    ];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(new Request(input, init));
      const response = responses.shift();
      if (!response) throw new Error("Unexpected PostHog request");
      return response;
    });
    const client = createPostHogPersonManagementClient({
      host: "https://us.posthog.com",
      projectId: "617",
      personalAPIKey: "phx_test_not_real",
      request,
    });

    await expect(client.listPersons({ distinctId: "user_617" })).resolves.toEqual([
      {
        personUUID,
        distinctIds: ["anonymous-617", "user_617"],
      },
    ]);
    await expect(client.bulkDelete({
      personUUID,
      deleteEvents: true,
      deleteRecordings: false,
      keepPerson: false,
    })).resolves.toEqual({
      personsFound: 1,
      personsDeleted: 1,
      eventsQueuedForDeletion: true,
      deletionErrors: [],
    });
    await expect(client.listDeletionStatus({ personUUID })).resolves.toEqual([
      {
        personUUID,
        status: "completed",
        deleteVerifiedAt: "2026-08-02T16:00:00.000Z",
      },
    ]);
    await expect(client.retrievePerson({ personUUID })).resolves.toEqual({ exists: false });

    expect(requests.map((value) => `${value.method} ${value.url}`)).toEqual([
      "GET https://us.posthog.com/api/projects/617/persons/?distinct_id=user_617",
      "POST https://us.posthog.com/api/projects/617/persons/bulk_delete/",
      `GET https://us.posthog.com/api/projects/617/persons/deletion_status/?person_uuid=${personUUID}`,
      `GET https://us.posthog.com/api/projects/617/persons/${personUUID}/`,
    ]);
    expect(requests.every(
      (value) => value.headers.get("authorization") === "Bearer phx_test_not_real",
    )).toBe(true);
    await expect(requests[1]?.json()).resolves.toEqual({
      ids: [personUUID],
      delete_events: true,
      delete_recordings: false,
      keep_person: false,
    });
  });

  it("rejects an ambiguous distinct-ID lookup instead of choosing a person", async () => {
    const client = {
      listPersons: vi.fn().mockResolvedValue([
        { personUUID, distinctIds: ["user_617"] },
        {
          personUUID: "61700000-0000-4000-8000-000000000002",
          distinctIds: ["user_617"],
        },
      ]),
      retrievePerson: vi.fn(),
      bulkDelete: vi.fn(),
      listDeletionStatus: vi.fn(),
    };
    const analytics = createPostHogAccountErasureAnalytics(client);

    await expect(
      analytics.resolvePersonUUID({ distinctId: "user_617" }),
    ).rejects.toThrow("PostHog person lookup was not exact");
  });

  it("does not confirm a queued event deletion while PostHog reports it pending", async () => {
    const client = {
      listPersons: vi.fn(),
      retrievePerson: vi.fn(),
      bulkDelete: vi.fn(),
      listDeletionStatus: vi.fn().mockResolvedValue([
        {
          personUUID,
          status: "pending" as const,
          deleteVerifiedAt: null,
        },
      ]),
    };
    const analytics = createPostHogAccountErasureAnalytics(client);

    await expect(
      analytics.deletePersonAndEvents({ personUUID }),
    ).resolves.toEqual({ confirmed: false });

    expect(client.bulkDelete).not.toHaveBeenCalled();
    expect(client.retrievePerson).not.toHaveBeenCalled();
  });

  it("does not confirm completed event deletion while the PostHog person still exists", async () => {
    const client = {
      listPersons: vi.fn(),
      retrievePerson: vi.fn().mockResolvedValue({ exists: true }),
      bulkDelete: vi.fn(),
      listDeletionStatus: vi.fn().mockResolvedValue([
        {
          personUUID,
          status: "completed" as const,
          deleteVerifiedAt: "2026-08-02T16:00:00.000Z",
        },
      ]),
    };
    const analytics = createPostHogAccountErasureAnalytics(client);

    await expect(
      analytics.deletePersonAndEvents({ personUUID }),
    ).resolves.toEqual({ confirmed: false });

    expect(client.retrievePerson).toHaveBeenCalledWith({ personUUID });
  });

  it("fails closed when completed status omits PostHog's verification timestamp", async () => {
    const client = {
      listPersons: vi.fn(),
      retrievePerson: vi.fn(),
      bulkDelete: vi.fn(),
      listDeletionStatus: vi.fn().mockResolvedValue([
        {
          personUUID,
          status: "completed" as const,
          deleteVerifiedAt: null,
        },
      ]),
    };
    const analytics = createPostHogAccountErasureAnalytics(client);

    await expect(
      analytics.deletePersonAndEvents({ personUUID }),
    ).resolves.toEqual({ confirmed: false });

    expect(client.bulkDelete).not.toHaveBeenCalled();
    expect(client.retrievePerson).not.toHaveBeenCalled();
  });

  it("starts real person and historical-event deletion without treating HTTP acceptance as proof", async () => {
    const client = {
      listPersons: vi.fn(),
      retrievePerson: vi.fn().mockResolvedValue({ exists: true }),
      bulkDelete: vi.fn().mockResolvedValue({
        personsFound: 1,
        personsDeleted: 1,
        eventsQueuedForDeletion: true,
        deletionErrors: [],
      }),
      listDeletionStatus: vi.fn().mockResolvedValue([]),
    };
    const analytics = createPostHogAccountErasureAnalytics(client);

    await expect(
      analytics.deletePersonAndEvents({ personUUID }),
    ).resolves.toEqual({ confirmed: false });

    expect(client.bulkDelete).toHaveBeenCalledWith({
      personUUID,
      deleteEvents: true,
      deleteRecordings: false,
      keepPerson: false,
    });
  });
});
