import { load } from "cheerio";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ErrorPage from "./error";
import NotFound from "./not-found";

/**
 * `aria-hidden` removes its whole subtree from the accessibility tree, not
 * just the element it decorates. Both pages wrap a decorative rule *and* the
 * page's kicker text in one `aria-hidden` span, so a screen-reader user gets
 * neither "Something broke" nor "Error 404" — only the h1 remains, silently
 * dropping the framing every sighted visitor sees. Every other decorative
 * element in the codebase (marketing FAQ rule, auth layout's prism divs)
 * hides an empty, contentless node — never one carrying real text.
 */
describe("error/not-found kicker text stays out of aria-hidden subtrees", () => {
  it("keeps error.tsx's 'Something broke' framing reachable to assistive tech", () => {
    const html = renderToStaticMarkup(
      <ErrorPage error={new Error("boom")} reset={() => {}} />,
    );
    const $ = load(html);

    expect(html).toContain("Something broke");
    expect($('[aria-hidden="true"]').text()).not.toContain("Something broke");
  });

  it("keeps not-found.tsx's 'Error 404' framing reachable to assistive tech", () => {
    const html = renderToStaticMarkup(<NotFound />);
    const $ = load(html);

    expect(html).toContain("Error 404");
    expect($('[aria-hidden="true"]').text()).not.toContain("Error 404");
  });
});
