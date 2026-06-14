/**
 * Click-accuracy verifier for the demo-video suite.
 *
 * For every click moment in every suite video it recomputes the cursor
 * position at the click frame from the *same* waypoint constants the
 * composition renders with, and asserts:
 *
 *   1. cursor tip position == center(target rect) at the click frame
 *      (exact to < 0.01 logical px),
 *   2. the click happens inside the dwell window with >= 12 frames of
 *      dwell after arrival (no rushed clicks),
 *   3. the cursor is still on target through the end of the dwell.
 *
 * Run: pnpm exec tsx remotion/suite/assert-clicks.ts
 */

import { BUYER_QA_LEN, QA_CLICKS, qaCursorAt } from "./BuyerQA";
import { HERO_CLICKS, HERO_VISION_LEN, heroCursorAt } from "./HeroVision";
import { INBOX_QA_CLICKS, INBOX_QA_LEN, inboxQaCursorAt } from "./InboxQA";
import { IDENTIFY_CLICKS, STEP_IDENTIFY_LEN } from "./StepIdentify";
import { PRICE_CLICKS, STEP_PRICE_LEN, priceCursorAt } from "./StepPrice";
import { PUBLISH_CLICKS, STEP_PUBLISH_LEN, publishCursorAt } from "./StepPublish";
import { SNAP_CLICKS, STEP_SNAP_LEN, snapCursorAt } from "./StepSnap";
import { STEP_WRITE_LEN, WRITE_CLICKS, writeCursorAt } from "./StepWrite";
import { center, type ClickSpec } from "./theme";

const MIN_DWELL = 12;
const EPS = 0.01;

interface VideoSpec {
  id: string;
  len: number;
  clicks: ClickSpec[];
  cursorAt?: (frame: number) => { x: number; y: number };
}

const VIDEOS: VideoSpec[] = [
  { id: "hero-demo", len: HERO_VISION_LEN, clicks: HERO_CLICKS, cursorAt: heroCursorAt },
  { id: "step-snap", len: STEP_SNAP_LEN, clicks: SNAP_CLICKS, cursorAt: snapCursorAt },
  { id: "step-identify", len: STEP_IDENTIFY_LEN, clicks: IDENTIFY_CLICKS },
  { id: "step-price", len: STEP_PRICE_LEN, clicks: PRICE_CLICKS, cursorAt: priceCursorAt },
  { id: "step-write", len: STEP_WRITE_LEN, clicks: WRITE_CLICKS, cursorAt: writeCursorAt },
  { id: "step-publish", len: STEP_PUBLISH_LEN, clicks: PUBLISH_CLICKS, cursorAt: publishCursorAt },
  { id: "buyer-qa", len: BUYER_QA_LEN, clicks: QA_CLICKS, cursorAt: qaCursorAt },
  { id: "inbox-qa", len: INBOX_QA_LEN, clicks: INBOX_QA_CLICKS, cursorAt: inboxQaCursorAt },
];

let failures = 0;
let checked = 0;

for (const video of VIDEOS) {
  if (video.clicks.length === 0) {
    console.log(`\n${video.id}: no click moments (cursor-free by design)`);
    continue;
  }
  if (!video.cursorAt) {
    console.error(`\n${video.id}: has clicks but no cursorAt export`);
    failures++;
    continue;
  }
  console.log(`\n${video.id}:`);
  for (const click of video.clicks) {
    checked++;
    const target = center(click.target);
    const problems: string[] = [];

    // 1. exact position at the click frame
    const atClick = video.cursorAt(click.frame);
    const dx = Math.abs(atClick.x - target.x);
    const dy = Math.abs(atClick.y - target.y);
    if (dx > EPS || dy > EPS) {
      problems.push(
        `cursor at click frame ${click.frame} is (${atClick.x.toFixed(2)}, ${atClick.y.toFixed(2)}), ` +
          `target center is (${target.x}, ${target.y}), off by (${dx.toFixed(2)}, ${dy.toFixed(2)})`,
      );
    }

    // 2. unrushed: arrive + dwell before the click, click inside the window
    if (click.frame < click.arrive + MIN_DWELL) {
      problems.push(
        `click at ${click.frame} only ${click.frame - click.arrive} frames after arrival ${click.arrive} (< ${MIN_DWELL})`,
      );
    }
    if (click.frame > click.until) {
      problems.push(`click at ${click.frame} is after the dwell window ends (${click.until})`);
    }
    if (click.frame >= video.len) {
      problems.push(`click frame ${click.frame} outside video (${video.len} frames)`);
    }

    // 3. cursor pinned to target for the whole dwell
    for (let f = click.arrive; f <= Math.min(click.until, video.len - 1); f++) {
      const p = video.cursorAt(f);
      if (Math.abs(p.x - target.x) > EPS || Math.abs(p.y - target.y) > EPS) {
        problems.push(
          `cursor leaves target during dwell at frame ${f}: (${p.x.toFixed(2)}, ${p.y.toFixed(2)})`,
        );
        break;
      }
    }

    if (problems.length === 0) {
      console.log(
        `  PASS  ${click.label}\n        click frame ${click.frame} @ (${target.x}, ${target.y}) · ` +
          `dwell ${click.frame - click.arrive} frames before click`,
      );
    } else {
      failures++;
      console.error(`  FAIL  ${click.label}`);
      for (const p of problems) console.error(`        ${p}`);
    }
  }
}

console.log(`\n${checked} click assertions, ${failures} failure(s)`);
if (failures > 0) process.exit(1);
