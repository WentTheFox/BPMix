import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// react-native-web is a drop-in replacement for the 'react-native' import
// specifier, which is how apps/mobile and this app share the same
// component code (App.tsx-style files written against RN primitives).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Aliased to the resolved absolute path (not the bare 'react-native-web'
      // specifier) because packages/ui imports 'react-native' from its own
      // directory, which has no node_modules entry for react-native-web under
      // pnpm's strict linking - only apps/web has it as a direct dependency.
      'react-native': require.resolve('react-native-web'),
      // react-native-svg's Fabric-native component files unconditionally
      // import 'react-native/Libraries/Utilities/codegenNativeComponent',
      // which doesn't exist under react-native-web - see
      // src/adapters/reactNativeSvgWeb.tsx for the full story.
      'react-native-svg': path.resolve(dirname, 'src/adapters/reactNativeSvgWeb.tsx'),
    },
    extensions: ['.web.tsx', '.web.ts', '.tsx', '.ts', '.jsx', '.js'],
  },
  define: {
    __DEV__: JSON.stringify(process.env.NODE_ENV !== 'production'),
    // react-native-web's Animated implementation (TimingAnimation.stop, hit
    // whenever an Animated.Image's fade-in - e.g. TrackRow's cover art - is
    // torn down mid-animation on unmount) references the Node-style global
    // object directly, which Vite's browser build doesn't provide - confirmed
    // on-device as `ReferenceError: global is not defined`, crashing the
    // whole app (no error boundary) any time enough rows unmount at once to
    // hit it (e.g. typing in TrackList's search box rapidly re-filters and
    // unmounts many rows). `global: 'window'` is the standard shim other
    // vite+react-native-web setups need for the same reason.
    global: 'window',
  },
});
