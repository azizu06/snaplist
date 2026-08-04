const association = {
  webcredentials: {
    apps: ["35YFS8XJRQ.dev.snaplist.ios"],
  },
} as const;

export function GET(): Response {
  return Response.json(association, {
    headers: {
      "Cache-Control": "public, max-age=3600",
    },
  });
}
