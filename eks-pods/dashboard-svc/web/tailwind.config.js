/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Pretendard', 'Inter', '"Noto Sans KR"', 'system-ui', 'sans-serif'],
      },
      colors: {
        // BookFlow palette (light theme · uiux.pen 기반)
        bf: {
          bg:        '#F1F3F5',
          panel:     '#FFFFFF',
          panel2:    '#F8F9FA',
          border:    '#DEE2E6',
          border2:   '#E9ECEF',
          text:      '#212529',
          text2:     '#495057',
          muted:     '#6C757D',
          sidebar:   '#212529',
          sidebar2:  '#343A40',
          primary:   '#3B82F6',
          primary2:  '#2563EB',
          primary3:  '#1D4ED8',
          ring:      '#DBEAFE',
          success:   '#065F46',
          successbg: '#D1FAE5',
          warn:      '#92400E',
          warnbg:    '#FEF3C7',
          danger:    '#991B1B',
          dangerbg:  '#FEE2E2',
          accent:    '#8B1A1A',
        },
      },
    },
  },
  plugins: [],
};
