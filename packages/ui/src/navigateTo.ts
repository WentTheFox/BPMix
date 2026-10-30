import { Linking } from 'react-native';

/** Opens an address: in the system browser on a device (see navigateTo.web.ts for the web version, which stays in the same tab). */
export function navigateTo(url: string): void {
  void Linking.openURL(url);
}
