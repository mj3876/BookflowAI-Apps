import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// In production, FastAPI mounts dist/ at /.
// In dev, vite proxies API/WS to:
//   - VITE_BFF_URL env (default: NLB external URL · 즉시 BFF 사용 가능)
//   - 또는 localhost:8000 if running FastAPI 로컬
//
// Usage:
//   cd web
//   VITE_BFF_URL=http://a01...elb.amazonaws.com npm run dev   # NLB 백엔드 사용
//   npm run dev                                                # default = NLB
//   VITE_BFF_URL=http://localhost:8000 npm run dev             # 로컬 FastAPI
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const bff = env.VITE_BFF_URL ?? 'http://a01e064cc1d984456be34dd1d1eab5e3-3c87226ff76f7eed.elb.ap-northeast-1.amazonaws.com';
  const wsBff = bff.replace(/^http/, 'ws');

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/dashboard': { target: bff,   changeOrigin: true },
        '/ws':        { target: wsBff, ws: true, changeOrigin: true },
        '/health':    { target: bff,   changeOrigin: true },
      },
    },
    build: { outDir: 'dist', sourcemap: false },
  };
});
