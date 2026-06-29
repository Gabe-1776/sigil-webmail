import { create } from 'zustand';

interface GrantsDrawerState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

export const useGrantsDrawerStore = create<GrantsDrawerState>()((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));
