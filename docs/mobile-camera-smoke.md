# Mobile camera capture smoke

Run this on a physical iPhone in Safari and an Android phone in Chrome. Use a
non-production account and stop before **Build my listing** / **Process batch**;
this smoke only verifies local capture and preview behavior.

For both `/upload` and `/batch`:

1. Tap **Take photo** and verify the rear/environment camera opens.
2. Capture one image and accept it. Verify the browser returns directly to
   SnapList and the image appears as the cover preview.
3. Tap **Take photo** three more times. Verify each accepted angle appends in
   order until the counter reads **4 of 4** and both photo actions are disabled.
4. Remove one angle, capture it again, and verify the repeated selection
   appends and both actions become available before returning to the cap.
5. Open **Take photo**, cancel without capturing, and verify the draft, counter,
   and submission state do not change.
6. Verify **Choose photos** remains available below the cap and opens the
   ordinary multi-select photo library.

Desktop and browsers that ignore `capture="environment"` may show an ordinary
image picker for **Take photo**. That fallback is expected; **Choose photos**
must remain available.
