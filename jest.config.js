// Jest runs the TypeScript sources as native ES modules (the project is
// "type": "module"), with SWC stripping types. Imports keep their .ts
// extensions, matching how Node runs the CLI.

/** @type {import("jest").Config} */
export default {
  testEnvironment: "node",
  testMatch: ["<rootDir>/test/**/*.test.ts"],
  extensionsToTreatAsEsm: [".ts"],
  transform: {
    "^.+\\.ts$": ["@swc/jest", { jsc: { parser: { syntax: "typescript" }, target: "es2022" }, module: { type: "es6" } }],
  },
  restoreMocks: true,
  collectCoverageFrom: ["src/**/*.ts", "!src/cli.ts"],
};
