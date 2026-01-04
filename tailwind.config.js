/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./renderer.html",
    "./src/**/*.{js,jsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
    },
  },
}
