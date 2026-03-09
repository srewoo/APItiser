export const notify = (title: string, message: string): void => {
  chrome.notifications.create(
    {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon-128.png'),
      title,
      message
    },
    () => {
      if (chrome.runtime.lastError) {
        console.warn('Notification create failed:', chrome.runtime.lastError.message);
      }
    }
  );
};
