import { expect, test, type Page, type TestInfo } from "@playwright/test";

const PREVIEW_PATH = "/dev/preview/durable-progress";

function previewUrl(
  testInfo: TestInfo,
  flow: "single" | "batch",
  scenario:
    | "queued"
    | "slow"
    | "retrying"
    | "ready"
    | "failed"
    | "partial-failure",
) {
  const theme = testInfo.project.use.colorScheme === "dark" ? "dark" : "light";
  return `${PREVIEW_PATH}/${flow}/${scenario}/${theme}`;
}

async function expectNoHorizontalOverflow(page: Page) {
  const result = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const offenders = Array.from(document.querySelectorAll<HTMLElement>("body *"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          testId: element.dataset.testid ?? null,
          left: rect.left,
          right: rect.right,
        };
      })
      .filter(({ left, right }) => left < -0.5 || right > viewportWidth + 0.5)
      .slice(0, 10);

    return {
      viewportWidth,
      scrollWidth: document.documentElement.scrollWidth,
      offenders,
    };
  });

  expect(
    result.scrollWidth,
    `horizontal overflow: ${JSON.stringify(result.offenders)}`,
  ).toBeLessThanOrEqual(result.viewportWidth + 1);
  expect(result.offenders, `elements outside the viewport`).toEqual([]);
}

async function expectThemeAndMotion(page: Page, testInfo: TestInfo) {
  const expectedTheme = testInfo.project.use.colorScheme === "dark" ? "dark" : "light";
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.documentElement.classList.contains("dark") ? "dark" : "light",
      ),
    )
    .toBe(expectedTheme);

  const expectsReducedMotion =
    testInfo.project.use.contextOptions?.reducedMotion === "reduce";
  expect(
    await page.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches),
  ).toBe(expectsReducedMotion);

  if (expectsReducedMotion) {
    const activeAnimations = await page
      .getByTestId("durable-progress")
      .evaluate((root) =>
        Array.from(root.querySelectorAll<HTMLElement>("*"))
          .filter((element) => {
            const style = getComputedStyle(element);
            return style.animationName !== "none" && style.animationDuration !== "0s";
          })
          .map((element) => ({
            tag: element.tagName.toLowerCase(),
            testId: element.dataset.testid ?? null,
            animationName: getComputedStyle(element).animationName,
          })),
      );
    expect(activeAnimations, "progress UI must stop decorative CSS animation").toEqual([]);
  }
}

async function runSnapshot(page: Page) {
  return page.getByTestId("run-row").evaluateAll((rows) =>
    rows.map((row) => ({
      id: row.getAttribute("data-run-id"),
      status: row.getAttribute("data-run-status"),
      text: row.textContent?.replace(/\s+/g, " ").trim(),
    })),
  );
}

test.beforeEach(async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  test.info().annotations.push({
    type: "browser-errors",
    description: "Captured and asserted after each test",
  });
  (page as Page & { __browserErrors?: string[] }).__browserErrors = browserErrors;
});

test.afterEach(async ({ page }) => {
  const browserErrors =
    (page as Page & { __browserErrors?: string[] }).__browserErrors ?? [];
  // The root ClerkProvider can attempt its external development bootstrap even
  // on this public, fixture-only route. Keep the preview offline-deterministic
  // while still failing every application error; the filter requires Clerk's
  // own host and fetch stack, so a SnapList `Failed to fetch` remains visible.
  const relevantErrors = browserErrors.filter(
    (error) =>
      !(error.includes("Failed to fetch") && error.includes("clerk.accounts.dev")),
  );
  expect(
    relevantErrors,
    "browser console/page errors",
  ).toEqual([]);
});

test("single run stays recoverable through slow work, refresh, and every terminal label", async ({
  page,
}, testInfo) => {
  await page.goto(previewUrl(testInfo, "single", "slow"));

  const progress = page.getByTestId("durable-progress");
  const run = page.getByTestId("run-row");
  await expect(progress).toBeVisible();
  await expect(run).toHaveCount(1);
  await expect(run).toHaveAttribute("data-run-status", "running");
  await expect(run).toContainText("Researching the price");
  await expect(progress.locator('[aria-live="polite"]')).toBeVisible();

  const beforeRefresh = await runSnapshot(page);
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.reload();
  await expect(page.getByTestId("run-row")).toHaveCount(1);
  expect(await runSnapshot(page)).toEqual(beforeRefresh);

  const refresh = page.getByRole("button", { name: /refresh status/i });
  await expect(refresh).toBeVisible();
  await refresh.click();
  await expect(page.getByTestId("run-row")).toHaveAttribute("data-run-status", "running");

  for (const fixture of [
    { scenario: "queued" as const, status: "queued", label: "Queued" },
    { scenario: "retrying" as const, status: "retrying", label: "Retrying" },
    { scenario: "ready" as const, status: "succeeded", label: "Ready for review" },
    { scenario: "failed" as const, status: "failed", label: "Failed" },
  ]) {
    await page.goto(previewUrl(testInfo, "single", fixture.scenario));
    const fixtureRun = page.getByTestId("run-row");
    await expect(fixtureRun).toHaveAttribute("data-run-status", fixture.status);
    await expect(fixtureRun).toContainText(fixture.label);
    if (fixture.status === "failed") {
      await expect(fixtureRun.getByRole("button", { name: "Try again" })).toBeVisible();
      await expect(fixtureRun).toContainText("Live updates unavailable");
      await fixtureRun.getByRole("button", { name: /refresh status/i }).click();
      await expect(page.getByText("Status checked")).toBeVisible();
    }
  }

  await expectThemeAndMotion(page, testInfo);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("single-durable-progress.png"),
    fullPage: true,
  });
});

test("batch progress preserves order while slow work and a partial failure stay honest", async ({
  page,
}, testInfo) => {
  await page.goto(previewUrl(testInfo, "batch", "partial-failure"));

  const progress = page.getByTestId("durable-progress");
  const rows = page.getByTestId("run-row");
  await expect(progress).toBeVisible();
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute("data-run-status", "succeeded");
  await expect(rows.nth(0)).toContainText("Ready for review");
  await expect(rows.nth(1)).toHaveAttribute("data-run-status", "running");
  await expect(rows.nth(1)).toContainText("Drafting the listing");
  await expect(rows.nth(2)).toHaveAttribute("data-run-status", "failed");
  await expect(rows.nth(2)).toContainText("Failed");

  const beforeRefresh = await runSnapshot(page);
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.reload();
  expect(await runSnapshot(page)).toEqual(beforeRefresh);

  await expectThemeAndMotion(page, testInfo);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("batch-partial-failure.png"),
    fullPage: true,
  });
});
