import { Switch, type ColorValue } from 'react-native';

export interface AppSwitchProps {
  value: boolean;
  onValueChange: (value: boolean) => void;
  accentColor: ColorValue;
}

/**
 * A Switch pinned to a plain white thumb in both states, tinting only the
 * track with the given accent color - Android's (and react-native-web's)
 * default thumb color is a fixed teal, unrelated to the app's own
 * accent/theme.
 *
 * react-native-web's Switch (unlike native RN's) reads the ON-state thumb
 * color from a separate `activeThumbColor` prop, falling back to its own
 * default teal (#009688) if that prop is missing - passing only
 * `thumbColor` (which react-native-web uses for the OFF state alone) left
 * every switch's ON-state knob a stray teal on web while native platforms,
 * whose `Switch` applies `thumbColor` to both states, looked correct.
 * `activeThumbColor` isn't part of react-native's own SwitchProps (it's a
 * web-only prop react-native-web reads off the raw props object), so it's
 * passed through an untyped spread rather than a real prop - harmless on
 * native, where React Native just ignores the unrecognized prop.
 */
export function AppSwitch({ value, onValueChange, accentColor }: AppSwitchProps) {
  return (
    <Switch
      value={value}
      onValueChange={onValueChange}
      trackColor={{ true: accentColor }}
      thumbColor="#ffffff"
      {...({ activeThumbColor: '#ffffff' } as Record<string, unknown>)}
    />
  );
}
