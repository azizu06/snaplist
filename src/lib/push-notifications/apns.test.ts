import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { decodeProtectedHeader, decodeJwt } from "jose";
import {
  createHttpApnsSender,
  resolveApnsConfig,
  type ApnsHttpRequest,
  type ApnsHttpResponse,
} from "./apns";

/**
 * Issue #891. The provider half of the seam, proved without touching Apple.
 *
 * Nothing here opens a socket. The transport is injected, so what is under test
 * is the part that is actually easy to get wrong and impossible to notice: the
 * host a token is sent to, the topic, the signature, and how Apple's refusals
 * are read. A push posted to the wrong APNs host is accepted and dropped, so a
 * mistake in any of those looks exactly like success.
 */

/**
 * A throwaway P-256 key, generated per run. The real `.p8` is a credential and
 * never appears in this repository, in a fixture, or in a log line; what this
 * test needs is a key of the right kind, not that key.
 */
let privateKeyPem: string;

const TEAM_ID = "35YFS8XJRQ";
const KEY_ID = "P2KF7JG56T";
const BUNDLE_ID = "com.snaplist.app";

const MESSAGE = {
  title: "Sony WH-1000XM4 is ready to review",
  body: "Open SnapList to check the details before you publish.",
};

const SANDBOX_DEVICE = {
  platform: "ios" as const,
  token: "a".repeat(64),
  environment: "sandbox" as const,
};
const PRODUCTION_DEVICE = {
  platform: "ios" as const,
  token: "b".repeat(64),
  environment: "production" as const,
};

beforeAll(() => {
  privateKeyPem = generateKeyPairSync("ec", { namedCurve: "P-256" })
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString();
});

/** Records every request and answers with whatever the test scripted. */
function recordingTransport(
  responses: ApnsHttpResponse[] = [{ status: 200, body: "" }],
) {
  const requests: ApnsHttpRequest[] = [];
  let call = 0;
  return {
    requests,
    async send(request: ApnsHttpRequest): Promise<ApnsHttpResponse> {
      requests.push(request);
      return responses[Math.min(call++, responses.length - 1)]!;
    },
  };
}

function senderWith(
  transport: { send(request: ApnsHttpRequest): Promise<ApnsHttpResponse> },
  now: () => number = () => 1_700_000_000_000,
) {
  return createHttpApnsSender({
    config: {
      bundleId: BUNDLE_ID,
      keyId: KEY_ID,
      privateKeyPem,
      teamId: TEAM_ID,
    },
    transport,
    now,
  });
}

function sendOf(device: typeof SANDBOX_DEVICE | typeof PRODUCTION_DEVICE) {
  return {
    device,
    message: MESSAGE,
    moment: "listingReady" as const,
    collapseId: "listingReady:run-1",
  };
}

describe("addressing a device", () => {
  it("posts a sandbox token to the sandbox host and a production token to the production one", async () => {
    // One auth key serves both, so the host is the only thing separating them
    // and nothing about the process can decide it.
    const transport = recordingTransport();
    const sender = senderWith(transport);

    await sender.send(sendOf(SANDBOX_DEVICE));
    await sender.send(sendOf(PRODUCTION_DEVICE));

    expect(transport.requests.map((request) => request.url)).toEqual([
      `https://api.sandbox.push.apple.com/3/device/${SANDBOX_DEVICE.token}`,
      `https://api.push.apple.com/3/device/${PRODUCTION_DEVICE.token}`,
    ]);
  });

  it("carries the bundle id as the topic and the collapse id Apple dedupes on", async () => {
    // Team Scoped keys are valid for every bundle in the team, so the topic is
    // configuration rather than a property of the credential.
    const transport = recordingTransport();

    await senderWith(transport).send(sendOf(PRODUCTION_DEVICE));

    expect(transport.requests[0]!.headers).toMatchObject({
      "apns-topic": BUNDLE_ID,
      "apns-collapse-id": "listingReady:run-1",
      "apns-push-type": "alert",
    });
  });

  it("sends the seller-facing copy exactly as the message service built it", async () => {
    const transport = recordingTransport();

    await senderWith(transport).send(sendOf(PRODUCTION_DEVICE));

    expect(JSON.parse(transport.requests[0]!.body)).toEqual({
      aps: {
        alert: { title: MESSAGE.title, body: MESSAGE.body },
        sound: "default",
      },
    });
  });
});

describe("proving who is sending", () => {
  it("signs with the key id in the header and the team id as the issuer", async () => {
    const transport = recordingTransport();

    await senderWith(transport).send(sendOf(PRODUCTION_DEVICE));

    const bearer = transport.requests[0]!.headers.authorization.replace(
      /^bearer /,
      "",
    );
    expect(decodeProtectedHeader(bearer)).toMatchObject({
      alg: "ES256",
      kid: KEY_ID,
    });
    expect(decodeJwt(bearer)).toMatchObject({ iss: TEAM_ID });
  });

  it("reuses one provider token rather than minting one per push", async () => {
    // Apple rejects a provider that re-signs too often, and a sender that mints
    // per notification hits that the first time a seller has two devices.
    const transport = recordingTransport([
      { status: 200, body: "" },
      { status: 200, body: "" },
    ]);
    const sender = senderWith(transport);

    await sender.send(sendOf(PRODUCTION_DEVICE));
    await sender.send(sendOf(SANDBOX_DEVICE));

    expect(transport.requests[0]!.headers.authorization).toBe(
      transport.requests[1]!.headers.authorization,
    );
  });

  it("mints a fresh provider token once the old one is too old to trust", async () => {
    // Apple refuses a token older than an hour, so it is re-signed well inside
    // that rather than at the boundary.
    let clock = 1_700_000_000_000;
    const transport = recordingTransport([
      { status: 200, body: "" },
      { status: 200, body: "" },
    ]);
    const sender = senderWith(transport, () => clock);

    await sender.send(sendOf(PRODUCTION_DEVICE));
    clock += 46 * 60 * 1000;
    await sender.send(sendOf(PRODUCTION_DEVICE));

    expect(transport.requests[0]!.headers.authorization).not.toBe(
      transport.requests[1]!.headers.authorization,
    );
  });
});

describe("reading Apple's answer", () => {
  it("treats an accepted notification as delivered", async () => {
    const sender = senderWith(recordingTransport([{ status: 200, body: "" }]));

    await expect(sender.send(sendOf(PRODUCTION_DEVICE))).resolves.toEqual({
      outcome: "delivered",
    });
  });

  it("reports a token Apple no longer knows as a device that is gone", async () => {
    // 410 is the unregistered case; the row is a dead address and the caller
    // deletes it. Left in place it is a token that fails on every future push.
    const sender = senderWith(
      recordingTransport([
        { status: 410, body: JSON.stringify({ reason: "Unregistered" }) },
      ]),
    );

    await expect(sender.send(sendOf(PRODUCTION_DEVICE))).resolves.toEqual({
      outcome: "deviceGone",
    });
  });

  it("reads a bad device token as gone rather than as a transient failure", async () => {
    // Apple answers 400 for this, the same status as a malformed payload, so
    // the reason is what separates a dead address from a bug in the sender.
    const sender = senderWith(
      recordingTransport([
        { status: 400, body: JSON.stringify({ reason: "BadDeviceToken" }) },
      ]),
    );

    await expect(sender.send(sendOf(PRODUCTION_DEVICE))).resolves.toEqual({
      outcome: "deviceGone",
    });
  });

  it("reports any other refusal as failed, naming Apple's reason", async () => {
    const sender = senderWith(
      recordingTransport([
        { status: 403, body: JSON.stringify({ reason: "ExpiredProviderToken" }) },
      ]),
    );

    await expect(sender.send(sendOf(PRODUCTION_DEVICE))).resolves.toEqual({
      outcome: "failed",
      reason: "ExpiredProviderToken",
    });
  });

  it("reports a refusal with no readable body without inventing a reason", async () => {
    const sender = senderWith(
      recordingTransport([{ status: 503, body: "<html>gateway</html>" }]),
    );

    await expect(sender.send(sendOf(PRODUCTION_DEVICE))).resolves.toEqual({
      outcome: "failed",
      reason: "apns_status_503",
    });
  });

  it("reports a transport that never answered as failed rather than delivered", async () => {
    const sender = senderWith({
      async send() {
        throw new Error("socket hang up");
      },
    });

    await expect(sender.send(sendOf(PRODUCTION_DEVICE))).resolves.toMatchObject({
      outcome: "failed",
    });
  });
});

describe("starting up without the credential", () => {
  it("names every missing variable instead of failing on the first one", () => {
    expect(() => resolveApnsConfig({})).toThrow(
      /APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, APNS_AUTH_KEY_PATH/,
    );
  });

  it("refuses a configuration that is missing only the key material", () => {
    // The loud version of the failure this whole seam exists to avoid: a push
    // path that starts, reports success, and sends nothing.
    expect(() =>
      resolveApnsConfig({
        APNS_KEY_ID: KEY_ID,
        APNS_TEAM_ID: TEAM_ID,
        APNS_BUNDLE_ID: BUNDLE_ID,
      }),
    ).toThrow(/APNS_AUTH_KEY_PATH/);
  });

  it("reads the key from the path it is given and never from the value", () => {
    // The `.p8` is a credential. It is loaded by path at startup so it cannot
    // end up in an environment dump, a build log, or a commit.
    const config = resolveApnsConfig(
      {
        APNS_KEY_ID: KEY_ID,
        APNS_TEAM_ID: TEAM_ID,
        APNS_BUNDLE_ID: BUNDLE_ID,
        APNS_AUTH_KEY_PATH: "/keys/AuthKey.p8",
      },
      (path) => {
        expect(path).toBe("/keys/AuthKey.p8");
        return privateKeyPem;
      },
    );

    expect(config).toEqual({
      bundleId: BUNDLE_ID,
      keyId: KEY_ID,
      privateKeyPem,
      teamId: TEAM_ID,
    });
  });

  it("refuses a key file that is not a private key", () => {
    expect(() =>
      resolveApnsConfig(
        {
          APNS_KEY_ID: KEY_ID,
          APNS_TEAM_ID: TEAM_ID,
          APNS_BUNDLE_ID: BUNDLE_ID,
          APNS_AUTH_KEY_PATH: "/keys/AuthKey.p8",
        },
        () => "not a key",
      ),
    ).toThrow(/APNS_AUTH_KEY_PATH/);
  });
});
