import type { AccountErasureAnalytics } from "./service";
import { z } from "zod";

export interface PostHogPersonManagementClient {
  listPersons(input: { distinctId: string }): Promise<Array<{
    personUUID: string;
    distinctIds: string[];
  }>>;
  retrievePerson(input: { personUUID: string }): Promise<{ exists: boolean }>;
  bulkDelete(input: {
    personUUID: string;
    deleteEvents: true;
    deleteRecordings: false;
    keepPerson: false;
  }): Promise<{
    personsFound: number;
    personsDeleted: number;
    eventsQueuedForDeletion: boolean;
    deletionErrors: unknown[];
  }>;
  listDeletionStatus(input: { personUUID: string }): Promise<Array<{
    personUUID: string;
    status: "pending" | "completed";
    deleteVerifiedAt: string | null;
  }>>;
}

type PostHogRequest = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const personListSchema = z.object({
  results: z.array(z.object({
    uuid: z.string().uuid(),
    distinct_ids: z.array(z.string()),
  }).passthrough()),
}).passthrough();

const bulkDeleteSchema = z.object({
  persons_found: z.number().int().nonnegative(),
  persons_deleted: z.number().int().nonnegative(),
  events_queued_for_deletion: z.boolean(),
  deletion_errors: z.array(z.unknown()).default([]),
}).passthrough();

const deletionStatusSchema = z.object({
  results: z.array(z.object({
    person_uuid: z.string().uuid(),
    status: z.enum(["pending", "completed"]),
    delete_verified_at: z.string().datetime({ offset: true }).nullable(),
  }).passthrough()),
}).passthrough();

export function createPostHogPersonManagementClient(input: {
  host: string;
  projectId: string;
  personalAPIKey: string;
  request?: PostHogRequest;
}): PostHogPersonManagementClient {
  const host = z.url().parse(input.host);
  const hostURL = new URL(host);
  if (hostURL.protocol !== "https:" || hostURL.hostname.includes(".i.posthog.com")) {
    throw new Error("PostHog erasure requires the private HTTPS app host.");
  }
  const projectId = z.string().regex(/^\d+$/).parse(input.projectId);
  const personalAPIKey = z.string().min(1).refine(
    (value) => !value.startsWith("phc_"),
    "PostHog erasure requires a personal API key, not a project token.",
  ).parse(input.personalAPIKey);
  const request = input.request ?? fetch;
  const baseURL = new URL(`/api/projects/${projectId}/persons/`, hostURL);
  const headers = {
    authorization: `Bearer ${personalAPIKey}`,
    "content-type": "application/json",
  };

  async function jsonRequest(
    url: URL,
    init: RequestInit,
    expectedStatus: number,
  ): Promise<unknown> {
    const response = await request(url, { ...init, headers: { ...headers, ...init.headers } });
    if (response.status !== expectedStatus) {
      throw new Error(`PostHog person API returned HTTP ${response.status}.`);
    }
    return response.json();
  }

  return {
    async listPersons({ distinctId }) {
      const url = new URL(baseURL);
      url.searchParams.set("distinct_id", z.string().min(1).parse(distinctId));
      const body = personListSchema.parse(await jsonRequest(url, { method: "GET" }, 200));
      return body.results.map((person) => ({
        personUUID: person.uuid,
        distinctIds: person.distinct_ids,
      }));
    },

    async retrievePerson({ personUUID }) {
      const safeUUID = z.string().uuid().parse(personUUID);
      const url = new URL(`${safeUUID}/`, baseURL);
      const response = await request(url, { method: "GET", headers });
      if (response.status === 404) return { exists: false };
      if (response.status !== 200) {
        throw new Error(`PostHog person API returned HTTP ${response.status}.`);
      }
      return { exists: true };
    },

    async bulkDelete({ personUUID, deleteEvents, deleteRecordings, keepPerson }) {
      const safeUUID = z.string().uuid().parse(personUUID);
      const body = bulkDeleteSchema.parse(await jsonRequest(
        new URL("bulk_delete/", baseURL),
        {
          method: "POST",
          body: JSON.stringify({
            ids: [safeUUID],
            delete_events: deleteEvents,
            delete_recordings: deleteRecordings,
            keep_person: keepPerson,
          }),
        },
        202,
      ));
      return {
        personsFound: body.persons_found,
        personsDeleted: body.persons_deleted,
        eventsQueuedForDeletion: body.events_queued_for_deletion,
        deletionErrors: body.deletion_errors,
      };
    },

    async listDeletionStatus({ personUUID }) {
      const safeUUID = z.string().uuid().parse(personUUID);
      const url = new URL("deletion_status/", baseURL);
      url.searchParams.set("person_uuid", safeUUID);
      const body = deletionStatusSchema.parse(
        await jsonRequest(url, { method: "GET" }, 200),
      );
      return body.results.map((status) => ({
        personUUID: status.person_uuid,
        status: status.status,
        deleteVerifiedAt: status.delete_verified_at,
      }));
    },
  };
}

export function createPostHogAccountErasureAnalytics(
  client: PostHogPersonManagementClient,
): AccountErasureAnalytics {
  return {
    async resolvePersonUUID({ distinctId }) {
      const people = await client.listPersons({ distinctId });
      if (people.length === 0) return null;
      if (
        people.length !== 1
        || !people[0]?.distinctIds.includes(distinctId)
      ) {
        throw new Error("PostHog person lookup was not exact.");
      }
      return people[0].personUUID;
    },

    async deletePersonAndEvents({ personUUID }) {
      const deletionStatus = await client.listDeletionStatus({ personUUID });
      if (deletionStatus.some((entry) => entry.status === "pending")) {
        return { confirmed: false };
      }
      const completed = deletionStatus.find(
        (entry) =>
          entry.personUUID === personUUID
          && entry.status === "completed"
          && entry.deleteVerifiedAt !== null,
      );
      if (completed) {
        const person = await client.retrievePerson({ personUUID });
        return { confirmed: !person.exists };
      }
      if (deletionStatus.length > 0) {
        return { confirmed: false };
      }
      const accepted = await client.bulkDelete({
        personUUID,
        deleteEvents: true,
        deleteRecordings: false,
        keepPerson: false,
      });
      if (
        accepted.personsFound !== 1
        || accepted.personsDeleted !== 1
        || !accepted.eventsQueuedForDeletion
        || accepted.deletionErrors.length > 0
      ) {
        throw new Error("PostHog did not accept the exact person and event deletion.");
      }
      return { confirmed: false };
    },
  };
}
