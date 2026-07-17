/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./App.tsx', './src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      // Design tokens from docs/ARCHITECTURE.md §3.1
      colors: {
        obsidian: '#0B0C10',
        charcoal: '#1F2833',
        gold: '#C5A059',
        goldBright: '#D4AF37',
        slate: '#C0C0C0',
        alabaster: '#F5F5F7',
        danger: '#B4544B',
      },
    },
  },
  plugins: [],
};
