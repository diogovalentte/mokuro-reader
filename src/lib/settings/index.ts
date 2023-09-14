import { browser } from "$app/environment";
import { writable } from "svelte/store";

type Settings = {
  zoomMode: 'keep' | 'something'
  rightToLeft: boolean;
  singlePageView: boolean;
  textEditable: boolean;
  textBoxBorders: boolean;
  displayOCR: boolean;
  boldFont: boolean;
  backgroundColor: string;
};

const defaultSettings: Settings = {
  zoomMode: 'keep',
  rightToLeft: true,
  singlePageView: false,
  displayOCR: true,
  textEditable: false,
  textBoxBorders: false,
  boldFont: false,
  backgroundColor: '#0d0d0f'
}

const stored = browser ? window.localStorage.getItem('settings') : undefined
const initialSettings: Settings = stored && browser ? JSON.parse(stored) : defaultSettings

export const settingsStore = writable<Settings>(initialSettings);

export function updateSetting(key: string, value: any) {
  settingsStore.update((settings) => {
    return {
      ...settings,
      [key]: value
    };
  });
}

export function resetSettings() {
  console.log('br', defaultSettings);

  settingsStore.set(defaultSettings);
}

settingsStore.subscribe((settings) => {
  if (browser) {
    window.localStorage.setItem('settings', JSON.stringify(settings))
  }
})
