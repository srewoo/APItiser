import { getPlatform } from '@shared/platform';

export const notify = (title: string, message: string): void => {
  const platform = getPlatform();
  platform.notifications.notify({
    title,
    message,
    iconUrl: platform.runtime.getURL('icon-128.png')
  });
};
