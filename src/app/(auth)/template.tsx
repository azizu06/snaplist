/**
 * Route-transition template (issue #49 round 4): re-mounts on every
 * navigation inside this group, replaying the .page-enter entrance so page
 * changes feel composed instead of hard-cut.
 *
 * `flex flex-1 flex-col` is load-bearing, not decoration: this wrapper sits
 * between the layout's grown flex column and the page's <main>. Left as a
 * plain block it stays at its natural content height and refuses to grow, so
 * <main>'s `flex-1` + `justify-center` had no slack to center within — the
 * card pinned to the top and all empty space pooled at the bottom on tall
 * screens. Growing as a column passes the full height straight down to <main>.
 */
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="page-enter flex flex-1 flex-col">{children}</div>;
}
