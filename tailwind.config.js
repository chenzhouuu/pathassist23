import animate from 'tailwindcss-animate'

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      // shadcn's token contract, which the vendored OHIF components are written against: every
      // colour is an unwrapped HSL triplet in :root, consumed as hsl(var(--name)). The `dsa.*`
      // scale below is the app's older hex palette; both are emitted from one source in
      // src/styles/index.css, so there is a single place to change a colour.
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        highlight: 'hsl(var(--highlight))',
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
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    }
  },
  plugins: [animate],
}
