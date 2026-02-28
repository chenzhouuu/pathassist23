/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        dsa: {
          bg: '#0d0e14',
          panel: '#13151f',
          sidebar: '#0f1119',
          toolbar: '#0a0b10',
          border: '#1e2130',
          accent: '#4da6ff',
          'accent-hover': '#6dbfff',
          danger: '#e94560',
          success: '#4caf82',
          warning: '#f5a623',
          text: '#cdd3e0',
          muted: '#6b7280',
          highlight: '#1a2035',
        }
      },
      fontFamily: {
        ui: ['IBM Plex Sans', 'system-ui', 'sans-serif'],
        mono: ['IBM Plex Mono', 'monospace'],
      }
    }
  },
  plugins: []
}
