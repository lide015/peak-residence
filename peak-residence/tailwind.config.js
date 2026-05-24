/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {},
  },
  // 動態色彩 class 需要 safelist，否則 build 時會被 purge 掉
  safelist: [
    { pattern: /^(bg|text|border)-(slate|stone|emerald|sky|amber|rose|teal|violet|cyan|blue)-(50|100|200|300|400|500|600|700|800|900)$/ },
    { pattern: /^(bg|text|border)-(slate|stone|emerald|sky|amber|rose|teal|violet)-(50|100|200|300|400|500|600|700|800|900)\/[0-9]+$/ },
    { pattern: /^from-(emerald|sky|amber|rose|stone|teal|violet)-(100|200)$/ },
    { pattern: /^via-(emerald|sky|amber|rose|stone|teal|violet)-(100)$/ },
    { pattern: /^to-(emerald|sky|amber|rose|stone|teal|violet|cyan|blue|orange|pink|purple)-(50)$/ },
  ],
  plugins: [],
}
