import { fileURLToPath } from 'node:url';

export default {
  plugins: {
    // Explicit path: use THIS project's Tailwind config even if the dev server starts from another folder.
    tailwindcss: { config: fileURLToPath(new URL('./tailwind.config.js', import.meta.url)) },
    autoprefixer: {},
  },
};
