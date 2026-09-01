import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// react-native-web is a drop-in replacement for the 'react-native' import
// specifier, which is how apps/mobile and this app share the same
// component code (App.tsx-style files written against RN primitives).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'react-native': 'react-native-web',
    },
    extensions: ['.web.tsx', '.web.ts', '.tsx', '.ts', '.jsx', '.js'],
  },
  define: {
    __DEV__: JSON.stringify(process.env.NODE_ENV !== 'production'),
  },
});
