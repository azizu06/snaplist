import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "SnapList",
    short_name: "SnapList",
    start_url: "/",
    display: "standalone",
    icons: [
      {
        src: "/web-app-icon-512.png",
        sizes: "512x512",
        type: "image/png",
      },
    ],
  };
}
