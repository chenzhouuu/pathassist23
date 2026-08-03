import animate from 'tailwindcss-animate'

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      // shadcn's token contract, which the vendored OHIF components are written against: every
      // colour is an unwrapped HSL triplet in :root, consumed as hsl(var(--name)). The triplets
      // are defined in src/styles/index.css, so there is a single place to change a colour.
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
          // OHIF's `primary-dark`, #090c29 — the same triplet --card already holds.
          dark: 'hsl(var(--card))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
          // OHIF's ui-next files are written against OHIF's own theme names. They are declared
          // here, bound to triplets the palette already carries, so a vendored file needs no class
          // edits and a re-sync from upstream stays a diff rather than a merge.
          // `secondary-dark` is OHIF's #041c4a — the same colour --popover already holds.
          dark: 'hsl(var(--popover))',
          // `secondary-light` is the one alias that is a choice rather than an identity: OHIF's
          // #3a3f99 has no exact twin here, and --input is the nearest by role (the edge colour on
          // a raised surface). Only the tooltip border uses it.
          light: 'hsl(var(--input))',
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
        // OHIF's #7bb2ce, which the palette already carries as --muted-foreground.
        aqua: {
          pale: 'hsl(var(--muted-foreground))',
        },
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
      // Radix measures an accordion's content and exposes the height as a custom property; the
      // keyframes that consume it ship in the config rather than the stylesheet. PanelSection is
      // an Accordion, so a collapse without these is instant instead of animated.
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    }
  },
  plugins: [animate],
}
