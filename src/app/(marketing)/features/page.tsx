import { permanentRedirect } from "next/navigation";

/**
 * /features (ui-r5-marketing) — retired. The page duplicated /how-it-works
 * (owner round-5 feedback: "the same exact thing being repeated"), so it now
 * permanently redirects there. Nav/footer links are removed separately.
 */
export default function Features() {
  permanentRedirect("/how-it-works");
}
