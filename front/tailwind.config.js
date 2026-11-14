/** @type {import('tailwindcss').Config} */
export default {
  // relative: paths resolve from this file, not from wherever the dev server was started.
  content: { relative: true, files: ['./index.html', './src/**/*.{ts,tsx}'] },
  theme: {
    extend: {
      colors: {
        space: '#0a0d14',
        neon: '#00f0ff',
        solar: '#ff9900',
        alert: '#ff003c',
      },
      fontFamily: {
        display: ['Orbitron', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      keyframes: {
        shake: {
          '0%, 100%': { transform: 'translate(0, 0)' },
          '20%': { transform: 'translate(-3px, 2px)' },
          '40%': { transform: 'translate(3px, -2px)' },
          '60%': { transform: 'translate(-2px, -3px)' },
          '80%': { transform: 'translate(2px, 3px)' },
        },
        flash: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.25' },
        },
        sweep: {
          from: { transform: 'rotate(0deg)' },
          to: { transform: 'rotate(360deg)' },
        },
        scanline: {
          from: { transform: 'translateY(-100%)' },
          to: { transform: 'translateY(100%)' },
        },
      },
      animation: {
        shake: 'shake 0.18s linear infinite',
        flash: 'flash 0.8s ease-in-out infinite',
        'flash-fast': 'flash 0.35s ease-in-out infinite',
        sweep: 'sweep 3s linear infinite',
        scanline: 'scanline 4s linear infinite',
      },
    },
  },
  plugins: [],
};
