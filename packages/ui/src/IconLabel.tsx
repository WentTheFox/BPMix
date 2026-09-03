import { StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { Icon } from './Icon';

export interface IconLabelProps {
  path: string;
  text: string;
  color: string;
  iconSize?: number;
  textStyle?: StyleProp<TextStyle>;
  containerStyle?: StyleProp<ViewStyle>;
}

/** An MDI icon followed by a text label in a row - the recurring "icon + text" pairing used for the title, Add Folder/Rescan actions, and folder/playlist names. Shared between mobile and web (identical on both, so it lives here rather than being duplicated per-app). */
export function IconLabel({ path, text, color, iconSize = 16, textStyle, containerStyle }: IconLabelProps) {
  return (
    <View style={[styles.row, containerStyle]}>
      <Icon path={path} size={iconSize} color={color} />
      <Text style={[{ color }, textStyle]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
});
