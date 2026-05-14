import { create } from "zustand";

export const useSmsStore = create((set, get) => ({
  templates: [],

  load: (arr) => set({ templates: arr }),

  add: (template) =>
    set((state) => ({ templates: [...state.templates, template] })),

  update: (sk, fields) =>
    set((state) => ({
      templates: state.templates.map((t) =>
        t.SmsTemplateSk === sk ? { ...t, ...fields } : t,
      ),
    })),

  remove: (sk) =>
    set((state) => ({
      templates: state.templates.filter((t) => t.SmsTemplateSk !== sk),
    })),

  getTemplates: () => get().templates,
}));
