const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

const fs = require('fs');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

// On Windows, require.resolve through yarn workspace junctions can return paths
// with a different drive letter case than process.cwd(). Metro's internal file
// system lookup is case-sensitive, so we normalize to match cwd.
function normalizePathDrive(p) {
  if (process.platform === 'win32' && p.length >= 2 && p[1] === ':') {
    return process.cwd()[0] + p.slice(1);
  }
  return p;
}

const rnwPath = normalizePathDrive(fs.realpathSync(
  path.resolve(require.resolve('react-native-windows/package.json'), '..'),
));

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
    blockList: [
      // This stops "npx @react-native-community/cli run-windows" from causing the metro server to crash if its already running
      new RegExp(
        `${path.resolve(__dirname, 'windows').replace(/[/\\]/g, '/')}.*`,
      ),
      // This prevents "npx @react-native-community/cli run-windows" from hitting: EBUSY: resource busy or locked, open msbuild.ProjectImports.zip or other files produced by msbuild
      new RegExp(`${rnwPath}/build/.*`),
      new RegExp(`${rnwPath}/target/.*`),
      /.*\.ProjectImports\.zip/,
    ],
  },
  transformer: {
    getTransformOptions: async () => ({
      transform: {
        experimentalImportSupport: false,
        inlineRequires: true,
      },
    }),
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
