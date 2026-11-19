/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      // 2026-11-19 look: Hanken Grotesk for the product UI, Sora for titles,
      // Ethiopic from the system (Nyala / Ebrima / Noto Sans Ethiopic).
      fontFamily: {
        sans: ['"Hanken Grotesk Variable"', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Nyala', 'Ebrima', '"Noto Sans Ethiopic"', 'system-ui', 'sans-serif'],
        display: ['"Sora Variable"', '"Hanken Grotesk Variable"', '-apple-system', 'Nyala', 'Ebrima', '"Noto Sans Ethiopic"', 'sans-serif'],
      },
      // One restrained palette: "teal" (the app's accent everywhere) is now the
      // brand's deep violet, and the greys are tinted to the purple-black ink.
      colors: {
        ink: '#0c0020',
        teal: { 50: '#f5f3fc', 100: '#ebe7f9', 200: '#d6cff2', 300: '#b8ade6', 400: '#968ad9', 500: '#6f60c6', 600: '#4a3a9e', 700: '#3e2e8a', 800: '#2f2270', 900: '#21185a', 950: '#140e38' },
        slate: { 50: '#f8f7fa', 100: '#f1f0f3', 200: '#e5e3ea', 300: '#d3d0d9', 400: '#a29dab', 500: '#77727f', 600: '#5a5562', 700: '#423d4a', 800: '#2a2531', 900: '#17131d', 950: '#0d0a12' },
        gray: { 50: '#f8f7fa', 100: '#f1f0f3', 200: '#e5e3ea', 300: '#d3d0d9', 400: '#a29dab', 500: '#77727f', 600: '#5a5562', 700: '#423d4a', 800: '#2a2531', 900: '#17131d', 950: '#0d0a12' },
      },
      borderRadius: { xl: '0.875rem', '2xl': '1.25rem' },
      // Smaller, tighter shadows (a big soft shadow is a big area to paint
      // again each time something near it changes).
      boxShadow: {
        soft: '0 6px 18px -10px rgba(12, 0, 32, 0.22)',
        lg: '0 6px 16px -6px rgb(15 23 42 / 0.16)',
        xl: '0 10px 24px -8px rgb(15 23 42 / 0.22)',
        '2xl': '0 16px 32px -12px rgb(15 23 42 / 0.3)',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'slide-up': {
          '0%': { opacity: '0', transform: 'translateY(100%)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        // Short: a page never waits for its own entrance.
        'fade-up': 'fade-in 0.12s ease-out backwards',
        'fade-in': 'fade-in 0.12s ease-out backwards',
        'slide-up': 'slide-up 0.2s cubic-bezier(.2,.8,.2,1) backwards',
      },
    },
  },
  plugins: [],
}