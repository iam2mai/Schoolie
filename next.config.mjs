// @ts-check

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Build a self-contained server (.next/standalone/server.js) with only the
  // traced dependencies, so the Docker runtime image needs no npm install.
  output: "standalone",

  // Next uses its own tsconfig so the root tsconfig.json keeps type-checking the
  // CLI and tests exactly as before.
  typescript: { tsconfigPath: "tsconfig.next.json" },

  // The semantic-search packages are loaded lazily and only when SEARCH_MODE is
  // on. Keep them out of the webpack bundle so the default keyword path stays
  // light and their optional native deps don't trip the build.
  serverExternalPackages: [
    "langchain",
    "@langchain/core",
    "@langchain/openai",
    "@langchain/pinecone",
    "@langchain/community",
    "@pinecone-database/pinecone",
  ],
};

export default nextConfig;
