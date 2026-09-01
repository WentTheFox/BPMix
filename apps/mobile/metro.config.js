const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * pnpm hoists shared deps into the workspace root and links them into
 * apps/mobile/node_modules via symlinks, so Metro needs symlink support
 * and both node_modules directories on its resolution path to see
 * @bpmix/core (packages/core) and hoisted third-party deps.
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  watchFolders: [workspaceRoot],
  resolver: {
    unstable_enableSymlinks: true,
    nodeModulesPaths: [
      path.resolve(projectRoot, 'node_modules'),
      path.resolve(workspaceRoot, 'node_modules'),
    ],
    // react-native-audio-api's main barrel re-exports an optional
    // Audio/AudioControls convenience UI we never import, but Metro still
    // has to resolve its imports of react-native-reanimated and
    // react-native-gesture-handler to bundle the reachable module graph.
    // Stubbed out rather than installing (and native-rebuilding for) two
    // real native libraries just to satisfy code this app never runs.
    extraNodeModules: {
      'react-native-reanimated': path.resolve(projectRoot, 'metro-stubs/react-native-reanimated.js'),
      'react-native-gesture-handler': path.resolve(projectRoot, 'metro-stubs/react-native-gesture-handler.js'),
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
