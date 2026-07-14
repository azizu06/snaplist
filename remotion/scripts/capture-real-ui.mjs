/**
 * Capture the real dev-preview routes for the marketing tour and inbox teaser.
 *
 * The preview routes render the shipped components with deterministic fixtures,
 * so these pixels stay coupled to the actual product instead of a hand-drawn
 * parallel interface. No credentials or production APIs are used.
 *
 *   pnpm demo:capture-ui
 *   DEMO_CAPTURE_BASE_URL=http://localhost:3211 pnpm demo:capture-ui
 */
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");
const OUTPUT_ROOT = path.join(REPO, "public", "demo", "captures");
const PORT = Number(process.env.DEMO_CAPTURE_PORT ?? 3217);
const OWN_SERVER = !process.env.DEMO_CAPTURE_BASE_URL;
const BASE_URL = process.env.DEMO_CAPTURE_BASE_URL ?? `http://localhost:${PORT}`;
const CAPTURE_ONLY = process.env.DEMO_CAPTURE_ONLY;

const SHOTS = [
  { name: "upload-empty", route: "/dev/preview/upload?capture=empty&focus=upload", focusSelector: "#upload-photos" },
  { name: "upload-filled", route: "/dev/preview/upload?capture=filled&focus=upload", focusSelector: "#upload-photos" },
  { name: "review-identify", route: "/dev/preview/review?focus=identify", focusSelector: "#review-identification" },
  { name: "review-price", route: "/dev/preview/review?focus=price", focusSelector: "#review-price-card" },
  { name: "review-write", route: "/dev/preview/review?focus=write", focusSelector: "#review-title" },
  { name: "publish-draft", route: "/dev/preview/publish?focus=publish", focusSelector: "#publish-action" },
  { name: "publish-live", route: "/dev/preview/publish-live?focus=publish", focusSelector: "#publish-action" },
  { name: "inbox-list", route: "/dev/preview/inbox-live?capture=list" },
  { name: "inbox-draft", route: "/dev/preview/inbox-live" },
  { name: "inbox-sent", route: "/dev/preview/inbox-live?capture=sent" },
];

const VIEWPORTS = {
  // These are the exact human-review viewport classes from #136. Device scale
  // only increases source density; layout remains 1440×900 / 390×844 CSS px.
  desktop: { width: 1440, height: 900, scale: 1.5 },
  mobile: { width: 390, height: 844, scale: 3 },
};

function resolveChromeExecutable() {
  const fromPath = (name) =>
    (process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, name));
  const candidates = [
    process.env.CHROME_PATH,
    ...(process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : []),
    ...fromPath("google-chrome"),
    ...fromPath("chromium"),
    ...fromPath("chromium-browser"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next platform/PATH candidate.
    }
  }
  throw new Error(
    "Could not find Chrome/Chromium. Set CHROME_PATH to an executable browser before running demo:capture-ui.",
  );
}

const CHROME = resolveChromeExecutable();

function connectCdp(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });

  return {
    async send(method, params = {}) {
      await opened;
      const id = nextId++;
      const response = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      socket.send(JSON.stringify({ id, method, params }));
      return response;
    },
    close() {
      socket.close();
    },
  };
}

async function waitForDebuggingUrl(child, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(
      () => reject(new Error(`Chrome debugging endpoint timed out\n${output.slice(-4000)}`)),
      timeoutMs,
    );
    const onData = (chunk) => {
      output += chunk;
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(match[1]);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("exit", (code) => {
      if (!output.includes("DevTools listening")) {
        clearTimeout(timeout);
        reject(new Error(`Chrome exited before debugging was ready (${code})\n${output}`));
      }
    });
  });
}

async function waitForCaptureReady(cdp, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await cdp.send("Runtime.evaluate", {
      expression:
        "document.readyState === 'complete' && document.documentElement.dataset.demoCaptureReady === 'true'",
      returnByValue: true,
    });
    if (result.result.value === true) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Preview did not report demoCaptureReady");
}

const MOBILE_LAYOUT_METRICS = `(() => {
  const viewportWidth = window.innerWidth;
  const rectFor = (element) => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: rect.width };
  };
  const rows = Array.from(
    document.querySelectorAll('nav[aria-label="Buyer conversations"] li button'),
  ).map(rectFor);
  const control = rectFor(
    document.querySelector('button[aria-label="Simulate a buyer question"]'),
  );
  return {
    viewportWidth,
    scrollWidth: document.documentElement.scrollWidth,
    rows,
    control,
  };
})()`;

function captureLayoutMetricsExpression(focusSelector) {
  return `(() => {
    const rectFor = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        width: rect.width, height: rect.height,
      };
    };
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      activeTheme: document.documentElement.classList.contains("dark") ? "dark" : "light",
      target: ${focusSelector ? `rectFor(document.querySelector(${JSON.stringify(focusSelector)}))` : "null"},
      offenders: Array.from(document.querySelectorAll("*"))
        .map((element) => ({
          tag: element.tagName,
          id: element.id,
          className: typeof element.className === "string" ? element.className.slice(0, 140) : "",
          rect: rectFor(element),
        }))
        .filter(({ rect }) => rect && (rect.left < -0.5 || rect.right > window.innerWidth + 0.5))
        .slice(0, 12),
    };
  })()`;
}

export function assertCaptureLayout(metrics, label, requiresTarget = false, expectedTheme) {
  const tolerance = 0.5;
  if (metrics.scrollWidth > metrics.viewportWidth + tolerance) {
    throw new Error(
      `${label}: document overflow (${metrics.scrollWidth} > ${metrics.viewportWidth}); offenders=${JSON.stringify(metrics.offenders ?? [])}`,
    );
  }
  if (metrics.scrollHeight <= 0 || metrics.viewportHeight <= 0) {
    throw new Error(`${label}: capture has no usable height`);
  }
  if (expectedTheme && metrics.activeTheme !== expectedTheme) {
    throw new Error(`${label}: theme mismatch (${metrics.activeTheme} !== ${expectedTheme})`);
  }
  if (!requiresTarget) return;
  const target = metrics.target;
  if (!target) throw new Error(`${label}: focused real-app target is missing`);
  if (target.width < 44 || target.height < 32) {
    throw new Error(`${label}: focused target is collapsed: ${JSON.stringify(target)}`);
  }
  if (target.bottom <= 0 || target.top >= metrics.viewportHeight) {
    throw new Error(`${label}: focused target is outside the viewport: ${JSON.stringify(target)}`);
  }
}

export function assertMobileInboxLayout(metrics, label) {
  const tolerance = 0.5;
  if (metrics.scrollWidth > metrics.viewportWidth + tolerance) {
    throw new Error(
      `${label}: document overflow (${metrics.scrollWidth} > ${metrics.viewportWidth})`,
    );
  }
  if (metrics.rows.length === 0) {
    throw new Error(`${label}: no conversation rows found for mobile overflow QA`);
  }
  for (const [index, rect] of metrics.rows.entries()) {
    if (!rect || rect.left < -tolerance || rect.right > metrics.viewportWidth + tolerance) {
      throw new Error(`${label}: row ${index + 1} escapes viewport: ${JSON.stringify(rect)}`);
    }
  }
  if (
    !metrics.control ||
    metrics.control.left < -tolerance ||
    metrics.control.right > metrics.viewportWidth + tolerance
  ) {
    throw new Error(`${label}: simulator control escapes viewport: ${JSON.stringify(metrics.control)}`);
  }
}

async function captureWithCdp({ url, viewport, output, theme, focusSelector, assertMobileInbox }) {
  const profile = await mkdtemp(path.join(os.tmpdir(), "snaplist-capture-"));
  const child = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-gpu",
      "--disable-sync",
      "--hide-scrollbars",
      "--no-default-browser-check",
      "--no-first-run",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let cdp;
  try {
    const browserUrl = await waitForDebuggingUrl(child);
    const port = new URL(browserUrl).port;
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) =>
      response.json(),
    );
    const page = targets.find((target) => target.type === "page");
    if (!page) throw new Error("Chrome did not expose a page target");
    cdp = connectCdp(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.scale,
      mobile: false,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
    });
    await cdp.send("Page.navigate", { url });
    await waitForCaptureReady(cdp);
    // next-themes can finish mounting after the preview controller's layout
    // effect. Re-assert the requested capture theme at the browser boundary so
    // a dark job can never silently encode a light screenshot (or vice versa).
    await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        document.documentElement.classList.toggle("dark", ${theme === "dark"});
        document.documentElement.classList.toggle("light", ${theme === "light"});
        document.documentElement.style.colorScheme = ${JSON.stringify(theme)};
        localStorage.setItem("theme", ${JSON.stringify(theme)});
      })()`,
    });
    await cdp.send("Runtime.evaluate", {
      expression: `(async () => {
        await document.fonts.ready;
        await Promise.all(
          Array.from(document.images)
            .filter((image) => !image.complete)
            .map((image) => image.decode().catch(() => undefined)),
        );
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      })()`,
      awaitPromise: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const layoutResult = await cdp.send("Runtime.evaluate", {
      expression: captureLayoutMetricsExpression(focusSelector),
      returnByValue: true,
    });
    assertCaptureLayout(layoutResult.result.value, output, Boolean(focusSelector), theme);

    if (assertMobileInbox) {
      const result = await cdp.send("Runtime.evaluate", {
        expression: MOBILE_LAYOUT_METRICS,
        returnByValue: true,
      });
      assertMobileInboxLayout(result.result.value, output);
    }

    const screenshot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    await writeFile(output, screenshot.data, "base64");
  } finally {
    cdp?.close();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 4,
      retryDelay: 100,
    });
  }
}

async function waitForServer(url, timeoutMs = 45_000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastError ?? "not ready")}`);
}

function withTheme(route, theme) {
  const url = new URL(route, BASE_URL);
  url.searchParams.set("theme", theme);
  return url.toString();
}

async function capture({ name, route, focusSelector, formFactor, theme }) {
  const viewport = VIEWPORTS[formFactor];
  const outputDir = path.join(OUTPUT_ROOT, formFactor, theme);
  const output = path.join(outputDir, `${name}.png`);
  await mkdir(outputDir, { recursive: true });
  await rm(output, { force: true });

  await captureWithCdp({
    url: withTheme(route, theme),
    viewport,
    output,
    theme,
    focusSelector,
    assertMobileInbox: formFactor === "mobile" && name === "inbox-list",
  });
  process.stdout.write(`  capture ✓ ${formFactor}/${theme}/${name}.png\n`);
}

async function mapLimit(items, limit, worker) {
  let cursor = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index]);
    }
  });
  await Promise.all(workers);
}

async function main() {
  let server;
  let serverLog = "";
  if (OWN_SERVER) {
    server = spawn(
      "pnpm",
      ["dev", "--hostname", "0.0.0.0", "--port", String(PORT)],
      {
        cwd: REPO,
        env: {
          ...process.env,
          NEXT_TELEMETRY_DISABLED: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    server.stdout.on("data", (chunk) => (serverLog += chunk));
    server.stderr.on("data", (chunk) => (serverLog += chunk));
  }

  try {
    await waitForServer(BASE_URL);
    const jobs = Object.keys(VIEWPORTS).flatMap((formFactor) =>
      ["light", "dark"].flatMap((theme) =>
        SHOTS.map(({ name, route, focusSelector }) => ({ name, route, focusSelector, formFactor, theme })),
      ),
    ).filter(({ name, formFactor, theme }) =>
      CAPTURE_ONLY ? `${formFactor}/${theme}/${name}` === CAPTURE_ONLY : true,
    );
    await mapLimit(jobs, 2, capture);
    process.stdout.write(`[capture-real-ui] ${jobs.length} real-UI captures written to ${OUTPUT_ROOT}\n`);
  } catch (error) {
    if (serverLog) process.stderr.write(serverLog.slice(-6000));
    throw error;
  } finally {
    if (server) {
      server.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (server.exitCode === null) server.kill("SIGKILL");
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
