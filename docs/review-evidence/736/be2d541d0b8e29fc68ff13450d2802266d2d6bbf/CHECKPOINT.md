# #736 candidate evidence checkpoint

The final candidate is based on `be2d541d0b8e29fc68ff13450d2802266d2d6bbf`.
This index separates final review evidence from earlier, superseded captures.

## Accepted evidence to commit

| Receipt | Result | Artifact | SHA-256 |
| --- | --- | --- | --- |
| `/tmp/snaplist-736-onboarding-visual-green-7.xcresult` | 9 total, 9 passed, 0 failed, 0 skipped | `Info.plist` | `4e16d605aeb25087a48ed1269af810c8581ac5478e98f1822987a304b0f8e59c` |
| visual GREEN 7 | accepted ONB-01 reduced motion | `post-visual-green-7/onb-01-reduced-motion.jpg` | `7a2b0642f25b0f492c886e79d004c95179a2f2ba24216b73a08fa899545e73d8` |
| visual GREEN 7 | semantic receipt | `post-visual-green-7/onb-01-reduced-motion.ax.txt` | `8fa8bc6c2417d5d43c52b9ec140b393ee6ac7bfb3330eea9ce77dfc2f0f0555b` |
| visual GREEN 7 | accepted ONB-05 rows/no-caption content | `post-visual-green-7/onb-05.jpg` | `f6d39334f742f80f66dfa913f489ec14c81eae88c03ca980091dda43127de915` |
| visual GREEN 7 | semantic receipt | `post-visual-green-7/onb-05.ax.txt` | `5cff93af1dffbbdff84d747ad7b284e17502dbee6fb18d7a5010d98349297645` |
| visual GREEN 7 | accepted normal ONB-06 | `post-visual-green-7/onb-06.jpg` | `211467a6618e8dfe986b1580a45cb8623e69586693470919fd971f88414cdfdc` |
| visual GREEN 7 | semantic receipt | `post-visual-green-7/onb-06.ax.txt` | `a450a728d53503935d06584e53f280d4f9493019c52942d05ae014987b35614f` |
| visual GREEN 7 | accepted ONB-06 accessibility5 reduced motion | `post-visual-green-7/onb-06-accessibility5-reduced-motion.jpg` | `f48c2416a544f710753fca337740d488891427fc41848085c012a60b596079a3` |
| visual GREEN 7 | semantic receipt | `post-visual-green-7/onb-06-accessibility5-reduced-motion.ax.txt` | `f048963ed2efa028db99c82532aa2261be734cc36f5fa387f872f0b07dffe4aa` |
| `/tmp/snaplist-736-onboarding-onb05-controls-green-3.xcresult` | 1 total, 1 passed, 0 failed, 0 skipped | `Info.plist` | `d3c37a8c5867df972e69f29618d840227e829af99938ecbc21e74b0a8f6027ed` |
| ONB-05 controls GREEN 3 | 402x874pt attachment exported at 3x (1206x2622px) | `post-onb05-controls-green-3/7AE31664-7848-470A-BDA1-5DF7EDAC3D12.png` | `20de99ced9409ece14e2f1d6e7b133e22020aa3a252e2c4ba10116883a4055b9` |
| ONB-05 controls GREEN 3 | xcresult attachment manifest | `post-onb05-controls-green-3/manifest.json` | `1cfe35f8a88fe96ee7782ab0d5cfea6ad75bc6ec03061913d6f7f400ce6fbb24` |

The Green 3 selector itself is the semantic receipt for Back, Skip, and Continue:
each existed, was hittable, had a minimum 44pt target, and fit within the
402x874pt window before it attached the screenshot.

## Excluded, superseded, or non-final artifacts

- Root-level `onb-*.jpg` files and `ax-receipts.md` predate final visual
  acceptance and remain untracked; do not use or commit them as final proof.
- `visual-red-1` and `visual-red-1b` were intentional RED bundles.
- `visual-green-1`, `visual-green-2`, `visual-green-3`, `visual-green-5`, and
  `visual-green-6` were incomplete execution results; `visual-green-4` was
  compile-only. None is final evidence.
- `onb05-controls-green-1` is the intentional Skip-target RED.
- `onb05-controls-green-2` passed its selector but XcodeBuildMCP could not
  produce a runtime snapshot; it is not final visual evidence.
