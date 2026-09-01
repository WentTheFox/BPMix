module.exports = {
  preset: '@react-native/jest-preset',
  // pnpm nests real packages under node_modules/.pnpm/<name>@<version>/node_modules/<name>,
  // so the default preset's transformIgnorePatterns (written for flat node_modules) matches
  // the outer ".pnpm" segment as "not an allowed package" and ignores everything. Treating
  // ".pnpm" itself as an allowed segment lets the pattern keep scanning to the real package name.
  transformIgnorePatterns: [
    'node_modules/(?!(\\.pnpm|(jest-)?react-native|@react-native(-community)?|react-native-scoped-storage|react-native-sqlite-2|react-native-audio-api)/)',
  ],
  // The preset defaults haste's platform resolution to iOS, which this project doesn't
  // target - without this, imports like './adapters/fileAccess' never resolve to the
  // .android.ts file since there's no unsuffixed or .ios.ts variant to fall back to.
  haste: {
    defaultPlatform: 'android',
    platforms: ['android', 'native'],
  },
};
