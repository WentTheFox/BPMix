import type { ReactNode } from 'react';

/**
 * Stand-in for 'react-native-svg' on the web build only (aliased in
 * vite.config.ts) - that package's Fabric-native component files
 * unconditionally import 'react-native/Libraries/Utilities/
 * codegenNativeComponent', which doesn't exist under react-native-web
 * (RNW has no Fabric codegen shim), breaking Vite's dependency scan
 * regardless of platform checks anywhere in *our* code. Icon.tsx (the only
 * consumer, everywhere in this repo - Windows uses its own glyph font
 * instead, see Icon.windows.tsx) only ever needs `Svg`/`Path`, so this
 * covers exactly that surface with real DOM SVG elements rather than
 * pulling in a whole separate web shim package for it.
 */

export interface SvgProps {
  width?: number;
  height?: number;
  viewBox?: string;
  children?: ReactNode;
}

export function Svg({ width, height, viewBox, children }: SvgProps): React.JSX.Element {
  return (
    <svg width={width} height={height} viewBox={viewBox}>
      {children}
    </svg>
  );
}

export interface PathProps {
  d: string;
  fill?: string;
}

export function Path({ d, fill }: PathProps): React.JSX.Element {
  return <path d={d} fill={fill} />;
}

export default Svg;
