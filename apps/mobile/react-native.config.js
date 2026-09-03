module.exports = {
  dependencies: {
    // react-native-svg's Windows native module (RNSVG.vcxproj) hardcodes
    // PlatformToolset=v143, which this machine's VS install ("18"/2026)
    // doesn't offer at all (only VS2022 does, and only VS18 is supported
    // for this react-native-windows version) - autolinking it in fails the
    // whole Windows build with MSB8020 before anything else compiles.
    // packages/ui/src/Icon.windows.tsx renders the same icons a different
    // way (a bundled font) instead of needing this on Windows at all;
    // Android/Web are unaffected, they still autolink/bundle it normally.
    'react-native-svg': {
      platforms: {
        windows: null,
      },
    },
  },
};
