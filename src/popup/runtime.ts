import type { CommandMessage, EventMessage } from '@shared/messages';

export const sendCommand = async <T extends EventMessage>(message: CommandMessage): Promise<T> => {
  return (await chrome.runtime.sendMessage(message)) as T;
};
