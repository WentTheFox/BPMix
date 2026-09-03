import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const dirname = path.dirname(fileURLToPath(import.meta.url));

// react-native-web is a drop-in replacement for the 'react-native' import
// specifier, which is how apps/mobile and this app share the same
// component code (App.tsx-style files written against RN primitives).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'react-native': 'react-native-web',
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
  },
});
