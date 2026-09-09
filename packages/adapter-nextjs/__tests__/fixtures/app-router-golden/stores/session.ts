import { create } from 'zustand';

export const useSessionStore = create(() => ({
  userId: 'user-1',
  clear: () => undefined,
}));
