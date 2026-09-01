module.exports = {
  preset: '@react-native/jest-preset',
  // pnpm nests real packages under node_modules/.pnpm/<name>@<version>/node_modules/<name>,
  // so the default preset's transformIgnorePatterns (written for flat node_modules) matches
  // the outer ".pnpm" segment as "not an allowed package" and ignores everything. Treating
  // ".pnpm" itself as an allowed segment lets the pattern keep scanning to the real package name.
  transformIgnorePatterns: [
    'node_modules/(?!(\\.pnpm|(jest-)?react-native|@react-native(-community)?)/)',
  ],
};
