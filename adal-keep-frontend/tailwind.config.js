/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['"DM Sans Variable"', '"DM Sans"', 'system-ui', 'sans-serif'],
        display: ['Syne', '"DM Sans Variable"', '"DM Sans"', 'sans-serif'],
      },
      colors: {
        ink: '#0f1c1a',
      },
      // Smaller, tighter shadows (a big soft shadow is a big area to paint
      // again each time something near it changes).
      boxShadow: {
        soft: '0 6px 18px -10px rgba(15, 28, 26, 0.25)',
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