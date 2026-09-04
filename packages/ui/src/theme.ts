import { useColorScheme } from 'react-native';

export interface Colors {
  background: string;
  text: string;
  subtleText: string;
}

export const lightColors: Colors = {
  background: '#ffffff',
  text: '#111111',
  subtleText: '#111111',
};

export const darkColors: Colors = {
  background: '#111111',
  text: '#f5f5f5',
  subtleText: '#f5f5f5',
};

/** Both apps computed this identically from useColorScheme() - shared so a future palette tweak only has one place to land. */
export function useThemeColors(): Colors {
  return useColorScheme() === 'dark' ? darkColors : lightColors;
}
