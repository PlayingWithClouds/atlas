import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Backend runs on :8123 (8000/8100 are veil's). Proxy /api so the browser talks
// to it same-origin — no CORS, and <img src="/api/…"> works with relative URLs.
// /veil proxies veil itself (:8080) for its cover-image cache/hotlink proxy.
const API_TARGET = process.env.PUBLIC_API_URL ?? 'http://localhost:8123';
const VEIL_TARGET = process.env.PUBLIC_VEIL_URL ?? 'http://localhost:8080';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	server: {
		proxy: {
			'/api': {
				target: API_TARGET,
				changeOrigin: true,
				ws: true,
				// Workflow runs push many WebSocket snapshots; when a browser tab or
				// socket closes mid-write the proxy would throw EPIPE/ECONNRESET and can
				// take down the dev server. Swallow those benign teardown errors.
				configure: (proxy) => {
					proxy.on('error', (err) => {
						const code = (err as NodeJS.ErrnoException).code;
						if (code === 'EPIPE' || code === 'ECONNRESET') return;
						console.error('[proxy] /api error:', err.message);
					});
				}
			},
			'/veil': {
				target: VEIL_TARGET,
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/veil/, '')
			}
		}
	}
});
