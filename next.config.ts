import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Phone photos routinely exceed Next's 1 MB Server Action body default, which
      // would reject the core upload flow before it runs. The `photos` Storage bucket
      // allows up to 50 MiB, so lift the request-body cap to match.
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
