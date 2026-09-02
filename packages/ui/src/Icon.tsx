import React from 'react';
import Svg, { Path } from 'react-native-svg';

export interface IconProps {
  /** An MDI path string, e.g. `mdiPlay` from '@mdi/js'. */
  path: string;
  size?: number;
  color?: string;
}

/** Renders one Material Design Icons glyph from its raw @mdi/js path data - see packages/ui/src/index.ts for why this replaced emoji glyphs. */
export function Icon({ path, size = 24, color = '#000' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d={path} fill={color} />
    </Svg>
  );
}
