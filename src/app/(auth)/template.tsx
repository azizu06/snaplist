/**
 * Route-transition template (issue #49 round 4): re-mounts on every
 * navigation inside this group, replaying the .page-enter entrance so page
 * changes feel composed instead of hard-cut.
 */
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="page-enter">{children}</div>;
}
