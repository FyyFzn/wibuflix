/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: '#0F1017',
        surface: '#181926',
        card: '#1E1F2E',
        accent: {
          DEFAULT: '#FF5722',
          hover: '#F4511E',
          light: '#FF8A65',
        }
      }
    },
  },
  plugins: [],
}
