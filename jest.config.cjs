/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          module: 'ESNext',
          moduleResolution: 'node',
        },
      },
    ],
  },
  testMatch: ['**/src/**/*.test.ts'],
  // Node's global fetch keeps pooled keep-alive sockets after the servers under test are closed.
  // The suites tear their servers down explicitly; this only stops the idle pool delaying exit.
  forceExit: true,
  transformIgnorePatterns: [
    'node_modules/',
  ],
};
