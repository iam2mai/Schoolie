// @ts-check

/** @type {import('next').NextConfig} */
const nextConfig = {
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
    "@pinecone-database/pinecone",
  ],
};

export default nextConfig;
